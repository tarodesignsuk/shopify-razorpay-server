@@ -3,6 +3,7 @@ const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
@@ -24,45 +25,20 @@ app.get('/', (req, res) => {

app.post('/api/create-payment', async (req, res) => {
    try {
        console.log('Create payment request received:', req.body);
        
        const { amount, currency, customer_details } = req.body;
        
        // VALIDATION: Check amount
        if (!amount || isNaN(amount) || amount <= 0) {
            console.error('Invalid amount:', amount);
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid amount',
                details: `Amount received: ${amount}`
            });
        }
        
        // Convert to paise (smallest currency unit)
        const { amount, currency } = req.body;

        // Convert to paise
        const amountInPaise = Math.round(amount * 100);
        
        // Razorpay requires minimum 100 paise (₹1)
        if (amountInPaise < 100) {
            console.error('Amount too small:', amountInPaise);
            return res.status(400).json({ 
                success: false, 
                error: 'Amount must be at least ₹1.00',
                details: `Amount in paise: ${amountInPaise}`
            });
        }
        

        const options = {
            amount: amountInPaise,
            currency: currency || "INR",
            receipt: `rcpt_${Date.now()}`,
            payment_capture: 1
        };
        
        console.log('Creating Razorpay order with options:', options);
        

        const order = await razorpay.orders.create(options);
        
        console.log('Razorpay order created successfully:', order.id);

        res.json({
            success: true,
            order_id: order.id,
@@ -85,8 +61,6 @@ app.post('/api/verify-payment', async (req, res) => {
            customer_details
        } = req.body;

        console.log('Verifying payment:', razorpay_payment_id);

        // 1. VERIFY SIGNATURE
        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
@@ -95,82 +69,66 @@ app.post('/api/verify-payment', async (req, res) => {
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            console.error('Invalid signature');
            return res.status(400).json({ success: false, message: "Invalid Signature" });
        }

        console.log('Signature verified ✓');

        // 2. GET PAYMENT DETAILS FROM RAZORPAY
        // 2. GET PAYMENT DETAILS
        const payment = await razorpay.payments.fetch(razorpay_payment_id);
        console.log('Payment status:', payment.status);

        // 3. PREPARE LINE ITEMS
        // Use final_price to respect discounts if available, otherwise price
        const line_items = cart_data.items.map(item => ({
            variant_id: item.variant_id,
            quantity: item.quantity,
            price: (item.price / 100).toFixed(2)
            // Shopify expects standard currency (Rupees), not cents/paise
            price: (item.final_price ? item.final_price / 100 : item.price / 100).toFixed(2) 
        }));

        // 4. CREATE SHOPIFY ORDER WITH TRANSACTION
        // 4. CREATE SHOPIFY ORDER
        const shopifyOrderData = {
            order: {
                line_items: line_items,
                // ROBUST FIX: Don't send phone in the main customer object to avoid "Phone taken" errors
                customer: {
                    first_name: customer_details.first_name,
                    last_name: customer_details.last_name,
                    email: customer_details.email,
                    phone: customer_details.phone
                    email: customer_details.email
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
                    country: "India",
                    phone: customer_details.phone // Phone is okay here in address
                },
                shipping_address: {
                    first_name: customer_details.first_name,
                    last_name: customer_details.last_name,
                    address1: customer_details.address,
                    city: customer_details.city,
                    province: customer_details.state,
                    zip: customer_details.zip,
                    country: customer_details.country || "India",
                    country: "India",
                    phone: customer_details.phone
                },
                financial_status: "paid",
                email: customer_details.email,
                send_receipt: true,
                send_fulfillment_receipt: false,
                note: customer_details.notes || '',
                tags: "Razorpay,paid",
                // CRITICAL: Add transaction to mark as paid
                inventory_behaviour: "bypass", // ROBUST FIX: Create order even if stock is weird
                financial_status: "paid",
                tags: "Razorpay, API",
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
                }]
            }
        };

        console.log('Creating Shopify order...');

        // 5. SEND TO SHOPIFY
        const shopifyResponse = await axios.post(
            `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json`,
            `https://${SHOPIFY_STORE}/admin/api/2023-10/orders.json`,
            shopifyOrderData,
            {
                headers: {
@@ -180,26 +138,25 @@ app.post('/api/verify-payment', async (req, res) => {
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
            order_name: shopifyResponse.data.order.name
        });

    } catch (error) {
        console.error("Error:", error.response ? error.response.data : error.message);
        // DETAILED ERROR LOGGING
        const errorDetails = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error("SHOPIFY ORDER FAILED. Details:", errorDetails);

        res.status(500).json({ 
            success: false, 
            error: "Payment verified but Shopify order failed.",
            error: "Order creation failed",
            details: error.response ? error.response.data : error.message
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
module.exports = app;
