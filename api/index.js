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

        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ success: false, message: "Invalid Signature" });
        }

        const line_items = cart_data.items.map(item => ({
            variant_id: item.variant_id,
            quantity: item.quantity,
            price: item.price / 100
        }));

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
                    zip: customer_details.zip,
                    country: "India"
                },
                shipping_address: {
                    first_name: customer_details.first_name,
                    last_name: customer_details.last_name,
                    address1: customer_details.address,
                    city: customer_details.city,
                    zip: customer_details.zip,
                    country: "India"
                },
                financial_status: "paid",
                tags: "Razorpay, API",
                note: `Razorpay Payment ID: ${razorpay_payment_id}`
            }
        };

        const shopifyResponse = await axios.post(
            `https://${SHOPIFY_STORE}/admin/api/2023-10/orders.json`,
            shopifyOrderData,
            {
                headers: {
                    'X-Shopify-Access-Token': SHOPIFY_TOKEN,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json({
            success: true,
            shopify_order_id: shopifyResponse.data.order.id,
            order_name: shopifyResponse.data.order.name
        });

    } catch (error) {
        console.error("Error creating Shopify order:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, error: "Payment verified but Shopify order failed." });
    }
});

module.exports = app;
