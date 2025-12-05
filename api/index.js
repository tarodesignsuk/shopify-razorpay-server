@@ -25,20 +25,20 @@ app.get('/', (req, res) => {

app.post('/api/create-payment', async (req, res) => {
    try {
        const { amount, currency } = req.body;

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
@@ -76,19 +76,17 @@ app.post('/api/verify-payment', async (req, res) => {
        const payment = await razorpay.payments.fetch(razorpay_payment_id);

        // 3. PREPARE LINE ITEMS
        // Use final_price to respect discounts if available, otherwise price
        const line_items = cart_data.items.map(item => ({
            variant_id: item.variant_id,
            quantity: item.quantity,
            // Shopify expects standard currency (Rupees), not cents/paise
            price: (item.final_price ? item.final_price / 100 : item.price / 100).toFixed(2) 
        }));

        // 4. CREATE SHOPIFY ORDER
        const shopifyOrderData = {
            order: {
                line_items: line_items,
                // ROBUST FIX: Don't send phone in the main customer object to avoid "Phone taken" errors
                // Customer identification (Email only to prevent phone conflicts)
                customer: {
                    first_name: customer_details.first_name,
                    last_name: customer_details.last_name,
@@ -99,21 +97,23 @@ app.post('/api/verify-payment', async (req, res) => {
                    last_name: customer_details.last_name,
                    address1: customer_details.address,
                    city: customer_details.city,
                    province: customer_details.state,
                    zip: customer_details.zip,
                    country: "India",
                    phone: customer_details.phone // Phone is okay here in address
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
                inventory_behaviour: "bypass", // ROBUST FIX: Create order even if stock is weird
                inventory_behaviour: "bypass",
                financial_status: "paid",
                tags: "Razorpay, API",
                transactions: [{
@@ -138,21 +138,22 @@ app.post('/api/verify-payment', async (req, res) => {
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
        // DETAILED ERROR LOGGING
        const errorDetails = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error("SHOPIFY ORDER FAILED. Details:", errorDetails);

        res.status(500).json({ 
            success: false, 
            error: "Order creation failed",
            details: error.response ? error.response.data : error.message
            details: errorDetails
        });
    }
});
