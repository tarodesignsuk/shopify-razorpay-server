const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// SAFETY FIX: Clean the store URL
const rawStore = process.env.SHOPIFY_STORE || "";
const SHOPIFY_STORE = rawStore.replace(/^https?:\/\//, '').replace(/\/$/, '');
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

app.get('/', (req, res) => {
    res.send('Shopify-Razorpay Middleware is Running');
});

app.post('/api/create-payment', async (req, res) => {
    try {
        const { amount, currency, customer_details } = req.body;
        const options = {
            amount: amount * 100,
            currency: currency || "INR",
            receipt: `rcpt_${Date.now()}`,
            payment_capture: 1
        };
        const order = await razorpay.orders.create(options);
        res.json({
            success: true,
            order_id: order.id,
            amount: order.amount,
            key_id: process.env.RAZORPAY_KEY_ID
        });
    } catch (error) {
        console.error("Error creating Razorpay order:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/verify-payment', async (req, res) => {
    try {
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            cart_data,
            customer_details
        } = req.body;

        console.log('Verifying payment:', razorpay_payment_id);

        // 1. VERIFY SIGNATURE
        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            console.error('Invalid signature');
            return res.status(400).json({ success: false, message: "Invalid Signature" });
        }

        console.log('Signature verified ✓');

        // 2. GET PAYMENT DETAILS FROM RAZORPAY
        const payment = await razorpay.payments.fetch(razorpay_payment_id);
        console.log('Payment status:', payment.status);

        // 3. PREPARE LINE ITEMS
        const line_items = cart_data.items.map(item => ({
            variant_id: item.variant_id,
            quantity: item.quantity,
            price: (item.price / 100).toFixed(2)
        }));

        // 4. CREATE SHOPIFY ORDER WITH TRANSACTION
        const shopifyOrderData = {
            order: {
                line_items: line_items,
                customer: {
                    first_name: customer_details.first_name,
                    last_name: customer_details.last_name,
                    email: customer_details.email,
                    phone: customer_details.phone
                },
                billing_address: {
                    first_name: customer_details.first_name,
                    last_name: customer_details.last_name,
                    address1: customer_details.address,
                    city: customer_details.city,
                    province: customer_details.state,
                    zip: customer_details.zip,
                    country: customer_details.country || "India",
                    phone: customer_details.phone
                },
                shipping_address: {
                    first_name: customer_details.first_name,
                    last_name: customer_details.last_name,
                    address1: customer_details.address,
                    city: customer_details.city,
                    province: customer_details.state,
                    zip: customer_details.zip,
                    country: customer_details.country || "India",
                    phone: customer_details.phone
                },
                financial_status: "paid",
                email: customer_details.email,
                send_receipt: true,
                send_fulfillment_receipt: false,
                note: customer_details.notes || '',
                tags: "Razorpay,paid",
                // CRITICAL: Add transaction to mark as paid
                transactions: [{
                    kind: 'sale',
                    status: 'success',
                    amount: (payment.amount / 100).toFixed(2),
                    gateway: 'Razorpay',
                    authorization: razorpay_payment_id,
                    currency: 'INR'
                }],
                note_attributes: [
                    { name: 'Payment Gateway', value: 'Razorpay' },
                    { name: 'Payment ID', value: razorpay_payment_id },
                    { name: 'Order ID', value: razorpay_order_id },
                    { name: 'Payment Method', value: payment.method }
                ]
            }
        };

        console.log('Creating Shopify order...');

        // 5. SEND TO SHOPIFY
        const shopifyResponse = await axios.post(
            `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json`,
            shopifyOrderData,
            {
                headers: {
                    'X-Shopify-Access-Token': SHOPIFY_TOKEN,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('Shopify order created:', shopifyResponse.data.order.name);

        // 6. RETURN SUCCESS
        res.json({
            success: true,
            payment_verified: true,
            shopify_order_id: shopifyResponse.data.order.id,
            order_name: shopifyResponse.data.order.name,
            order_number: shopifyResponse.data.order.order_number,
            message: 'Payment verified and order created successfully'
        });

    } catch (error) {
        console.error("Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ 
            success: false, 
            error: "Payment verified but Shopify order failed.",
            details: error.response ? error.response.data : error.message
        });
    }
});

module.exports = app;
