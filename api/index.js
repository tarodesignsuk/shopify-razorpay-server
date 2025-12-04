const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

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

// ===== STEP 1.1: CREATE CUSTOMER =====
app.post('/api/create-customer', async (req, res) => {
    try {
        console.log('Create customer request:', req.body);
        
        const { name, email, contact, notes } = req.body;
        
        // Validation
        if (!name || name.length < 5 || name.length > 50) {
            return res.status(400).json({ 
                success: false, 
                error: 'Name must be between 5-50 characters' 
            });
        }
        
        if (!contact || contact.length < 8) {
            return res.status(400).json({ 
                success: false, 
                error: 'Contact must be at least 8 digits including country code' 
            });
        }
        
        if (!email || !email.includes('@')) {
            return res.status(400).json({ 
                success: false, 
                error: 'Valid email required' 
            });
        }
        
        // Create customer in Razorpay
        const customer = await razorpay.customers.create({
            name: name,
            email: email,
            contact: contact,
            fail_existing: "0", // Return existing customer if duplicate
            notes: notes || {}
        });

        console.log('Customer created:', customer.id);

        res.json({
            success: true,
            customer_id: customer.id,
            customer: customer
        });
        
    } catch (error) {
        console.error("Customer creation error:", error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            details: error.toString()
        });
    }
});

app.post('/api/create-payment', async (req, res) => {
    try {
        const { amount, currency, customer_details } = req.body;
        
        // Convert to paise
        const amountInPaise = Math.round(amount * 100);
        
        const options = {
            amount: amountInPaise,
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

        // 1. VERIFY SIGNATURE
        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ success: false, message: "Invalid Signature" });
        }

        // 2. GET PAYMENT DETAILS
        const payment = await razorpay.payments.fetch(razorpay_payment_id);

        // 3. PREPARE LINE ITEMS
        const line_items = cart_data.items.map(item => ({
            variant_id: item.variant_id,
            quantity: item.quantity,
            price: (item.final_price ? item.final_price / 100 : item.price / 100).toFixed(2) 
        }));

        // 4. CREATE SHOPIFY ORDER
        const shopifyOrderData = {
            order: {
                line_items: line_items,
                // Customer identification (Email only to prevent phone conflicts)
                customer: {
                    first_name: customer_details.first_name,
                    last_name: customer_details.last_name,
                    email: customer_details.email
                },
                billing_address: {
                    first_name: customer_details.first_name,
                    last_name: customer_details.last_name,
                    address1: customer_details.address,
                    city: customer_details.city,
                    province: customer_details.state,
                    zip: customer_details.zip,
                    country: "India",
                    phone: customer_details.phone
                },
                shipping_address: {
                    first_name: customer_details.first_name,
                    last_name: customer_details.last_name,
                    address1: customer_details.address,
                    city: customer_details.city,
                    province: customer_details.state,
                    zip: customer_details.zip,
                    country: "India",
                    phone: customer_details.phone
                },
                email: customer_details.email,
                inventory_behaviour: "bypass",
                financial_status: "paid",
                tags: "Razorpay, API",
                transactions: [{
                    kind: 'sale',
                    status: 'success',
                    amount: (payment.amount / 100).toFixed(2),
                    gateway: 'Razorpay',
                    authorization: razorpay_payment_id,
                    currency: 'INR'
                }]
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

        // 5. SUCCESS! Send back the official Order Status URL
        res.json({
            success: true,
            shopify_order_id: shopifyResponse.data.order.id,
            // THIS IS THE KEY FIELD FOR THANK YOU PAGE
            order_status_url: shopifyResponse.data.order.order_status_url,
            order_name: shopifyResponse.data.order.name
        });

    } catch (error) {
        const errorDetails = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error("SHOPIFY ORDER FAILED. Details:", errorDetails);
        res.status(500).json({ 
            success: false, 
            error: "Order creation failed",
            details: errorDetails
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
module.exports = app;
