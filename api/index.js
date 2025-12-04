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
    res.send('Shopify-Razorpay Middleware is Running - Import Flow Edition');
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

// ===== STEP 1.2: CREATE ORDER (IMPORT FLOW) =====
app.post('/api/create-payment', async (req, res) => {
    try {
        console.log('Create order request:', req.body);
        
        const { 
            amount, 
            currency, 
            customer_id,
            customer_details,
            notes 
        } = req.body;
        
        // Validation
        if (!customer_id) {
            return res.status(400).json({ 
                success: false, 
                error: 'customer_id is required. Create customer first using /api/create-customer' 
            });
        }
        
        if (!amount || amount < 1) {
            return res.status(400).json({ 
                success: false, 
                error: 'Amount must be at least ₹1.00' 
            });
        }
        
        if (!customer_details || !customer_details.name || !customer_details.email || !customer_details.contact) {
            return res.status(400).json({ 
                success: false, 
                error: 'customer_details with name, email, and contact are required' 
            });
        }
        
        // Validate name (English letters only, 5-50 chars)
        const nameRegex = /^[A-Za-z\s]{5,50}$/;
        if (!nameRegex.test(customer_details.name)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Customer name must be 5-50 English letters only (no numbers/special chars)' 
            });
        }
        
        // Validate shipping address if provided
        if (customer_details.shipping_address) {
            const addr = customer_details.shipping_address;
            
            // Validate city and state (English letters only)
            const textRegex = /^[A-Za-z\s]+$/;
            if (addr.city && !textRegex.test(addr.city)) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'City must contain English letters only' 
                });
            }
            if (addr.state && !textRegex.test(addr.state)) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'State must contain English letters only' 
                });
            }
            
            // Validate address lines (alphanumeric + limited special chars)
            const addressRegex = /^[A-Za-z0-9\s\*&\/\-\(\)#_+\[\]:'".,]+$/;
            if (addr.line1 && !addressRegex.test(addr.line1)) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Address line1 contains invalid characters' 
                });
            }
            if (addr.line2 && !addressRegex.test(addr.line2)) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Address line2 contains invalid characters' 
                });
            }
        }
        
        // Convert to paise
        const amountInPaise = Math.round(amount * 100);
        
        // Create order with Import Flow structure
        const orderOptions = {
            amount: amountInPaise,
            currency: currency || "INR",
            receipt: `rcpt_${Date.now()}`,
            customer_id: customer_id,
            customer_details: customer_details,
            notes: notes || {
                source: "Shopify Import Flow"
            }
        };
        
        console.log('Creating order with options:', JSON.stringify(orderOptions, null, 2));
        
        const order = await razorpay.orders.create(orderOptions);
        
        console.log('Order created successfully:', order.id);

        res.json({
            success: true,
            order_id: order.id,
            amount: order.amount,
            currency: order.currency,
            key_id: process.env.RAZORPAY_KEY_ID,
            order: order
        });
        
    } catch (error) {
        console.error("Order creation error:", error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            details: error.toString(),
            description: error.error?.description || 'Unknown error'
        });
    }
});

// ===== STEP 1.6 & 1.7: VERIFY PAYMENT (ENHANCED FOR IMPORT FLOW) =====
app.post('/api/verify-payment', async (req, res) => {
    try {
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            cart_data,
            customer_details
        } = req.body;

        console.log('=== PAYMENT VERIFICATION START ===');
        console.log('Order ID:', razorpay_order_id);
        console.log('Payment ID:', razorpay_payment_id);

        // STEP 1.6: VERIFY SIGNATURE (HMAC SHA256)
        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            console.error('❌ Signature verification failed');
            return res.status(400).json({ 
                success: false, 
                message: "Invalid payment signature. Possible tampering detected." 
            });
        }

        console.log('✅ Signature verified');

        // STEP 1.7: VERIFY PAYMENT STATUS WITH RAZORPAY API
        const payment = await razorpay.payments.fetch(razorpay_payment_id);
        
        console.log('Payment Status:', payment.status);
        console.log('Payment Method:', payment.method);
        console.log('Payment Amount:', payment.amount / 100, 'INR');
        console.log('Payment Email:', payment.email);
        console.log('Payment Contact:', payment.contact);
        
        // Verify payment is captured
        if (payment.status !== 'captured') {
            console.error('❌ Payment not captured. Status:', payment.status);
            return res.status(400).json({ 
                success: false, 
                message: `Payment not captured. Current status: ${payment.status}` 
            });
        }
        
        // Verify order details match
        const orderDetails = await razorpay.orders.fetch(razorpay_order_id);
        
        if (payment.amount !== orderDetails.amount) {
            console.error('❌ Amount mismatch');
            console.error('Payment amount:', payment.amount);
            console.error('Order amount:', orderDetails.amount);
            return res.status(400).json({ 
                success: false, 
                message: "Payment amount does not match order amount" 
            });
        }
        
        console.log('✅ Payment verification complete');
        console.log('Order details:', {
            order_id: orderDetails.id,
            amount: orderDetails.amount / 100,
            currency: orderDetails.currency,
            status: orderDetails.status,
            customer_id: orderDetails.customer_id
        });

        // PREPARE LINE ITEMS FOR SHOPIFY
        const line_items = cart_data.items.map(item => ({
            variant_id: item.variant_id,
            quantity: item.quantity,
            price: (item.final_price ? item.final_price / 100 : item.price / 100).toFixed(2) 
        }));

        // CREATE SHOPIFY ORDER
        console.log('Creating Shopify order...');
        
        const shopifyOrderData = {
            order: {
                line_items: line_items,
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
                tags: "Razorpay, Import Flow, API",
                note: `Razorpay Payment ID: ${razorpay_payment_id}\nRazorpay Order ID: ${razorpay_order_id}\nPayment Method: ${payment.method}`,
                transactions: [{
                    kind: 'sale',
                    status: 'success',
                    amount: (payment.amount / 100).toFixed(2),
                    gateway: 'Razorpay',
                    authorization: razorpay_payment_id,
                    currency: payment.currency
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

        console.log('✅ Shopify order created:', shopifyResponse.data.order.id);
        console.log('=== PAYMENT VERIFICATION COMPLETE ===');

        // SUCCESS RESPONSE
        res.json({
            success: true,
            shopify_order_id: shopifyResponse.data.order.id,
            order_status_url: shopifyResponse.data.order.order_status_url,
            order_name: shopifyResponse.data.order.name,
            payment_details: {
                payment_id: razorpay_payment_id,
                order_id: razorpay_order_id,
                method: payment.method,
                amount: payment.amount / 100,
                currency: payment.currency,
                status: payment.status
            }
        });

    } catch (error) {
        const errorDetails = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error("❌ PAYMENT VERIFICATION FAILED");
        console.error("Error details:", errorDetails);
        console.error('=== PAYMENT VERIFICATION FAILED ===');
        
        res.status(500).json({ 
            success: false, 
            error: "Payment verification or order creation failed",
            details: errorDetails
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
module.exports = app;
