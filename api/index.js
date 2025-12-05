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

const SHOPIFY_STORE = (process.env.SHOPIFY_STORE || "").replace(/^https?:\/\//, '').replace(/\/$/, '');
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

app.get('/', (req, res) => {
    res.send('Shopify-Razorpay Server v2.0 - Running');
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        version: '2.0',
        timestamp: new Date().toISOString()
    });
});

app.post('/api/create-customer', async (req, res) => {
    try {
        const { name, email, contact, notes } = req.body;
        
        if (!name || !email || !contact) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }
        
        if (!contact.startsWith('+91')) {
            return res.status(400).json({ success: false, error: 'Indian phone number (+91) required' });
        }
        
        const customer = await razorpay.customers.create({
            name, email, contact,
            fail_existing: "0",
            notes: notes || {}
        });

        res.json({ success: true, customer_id: customer.id, customer });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/create-payment', async (req, res) => {
    try {
        const { amount, currency, customer_id, customer_details, notes } = req.body;
        
        if (!customer_id || !amount || amount < 1) {
            return res.status(400).json({ success: false, error: 'Invalid parameters' });
        }
        
        if (customer_details?.contact && !customer_details.contact.startsWith('+91')) {
            return res.status(400).json({ success: false, error: 'Indian phone number (+91) required' });
        }
        
        const order = await razorpay.orders.create({
            amount: Math.round(amount * 100),
            currency: currency || "INR",
            receipt: `rcpt_${Date.now()}`,
            customer_id,
            customer_details,
            notes: notes || {}
        });

        res.json({
            success: true,
            order_id: order.id,
            amount: order.amount,
            currency: order.currency,
            key_id: process.env.RAZORPAY_KEY_ID
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/verify-payment', async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, cart_data, customer_details } = req.body;

        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body.toString()).digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ success: false, message: "Invalid signature" });
        }

        const payment = await razorpay.payments.fetch(razorpay_payment_id);
        
        if (payment.status !== 'captured') {
            return res.status(400).json({ success: false, message: "Payment not captured" });
        }

        const line_items = cart_data.items.map(item => ({
            variant_id: item.variant_id,
            quantity: item.quantity,
            price: ((item.final_price || item.price) / 100).toFixed(2)
        }));

        const shopifyOrder = await axios.post(
            `https://${SHOPIFY_STORE}/admin/api/2023-10/orders.json`,
            {
                order: {
                    line_items,
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
                    financial_status: "paid",
                    tags: "Razorpay, Import Flow, API",
                    note: `Payment ID: ${razorpay_payment_id}`,
                    transactions: [{
                        kind: 'sale',
                        status: 'success',
                        amount: (payment.amount / 100).toFixed(2),
                        gateway: 'Razorpay'
                    }]
                }
            },
            {
                headers: {
                    'X-Shopify-Access-Token': SHOPIFY_TOKEN,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json({
            success: true,
            shopify_order_id: shopifyOrder.data.order.id,
            order_name: shopifyOrder.data.order.name,
            payment_details: {
                payment_id: razorpay_payment_id,
                order_id: razorpay_order_id
            }
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));

module.exports = app;
