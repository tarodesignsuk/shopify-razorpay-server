async function proceedToPayment() {
  if(isMockMode) return alert("Preview Mode: Payment Simulation");
  
  const btn = document.getElementById('continue-btn');
  btn.innerHTML = '<span class="spinner"></span> Validating...';
  btn.disabled = true;

  try {
    const customerDetails = getCustomerDetails();
    
    // Calculate final amount with discount
    let amount = cartData.total_price / 100;
    if (appliedDiscount) {
      amount = amount - (amount * (appliedDiscount.value / 100));
    }

    // ===== FRONTEND VALIDATION =====
    
    // Validation: Name must be 5-50 English letters only
    const fullName = customerDetails.first_name + ' ' + customerDetails.last_name;
    if (!/^[A-Za-z\s]{5,50}$/.test(fullName)) {
      throw new Error('Name must be 5-50 English letters only (no numbers or special characters)');
    }

    // Validation: Phone must be Indian number (+91)
    let phone = customerDetails.phone.trim();
    
    // Add +91 if not present
    if (!phone.startsWith('+')) {
      if (phone.startsWith('91')) {
        phone = '+' + phone;
      } else {
        phone = '+91' + phone;
      }
    }
    
    // Check if it's an Indian number
    if (!phone.startsWith('+91')) {
      throw new Error('⚠️ Razorpay Import Flow requires Indian phone numbers.\n\nPlease use an Indian mobile number starting with +91.\n\nExample: +91 9876543210');
    }
    
    // Validate Indian phone format
    if (!/^\+91[6-9]\d{9}$/.test(phone)) {
      throw new Error('Invalid Indian phone number format.\n\nRequired: +91 followed by 10 digits starting with 6, 7, 8, or 9.\n\nExample: +91 9876543210');
    }
    
    // Update phone in customerDetails
    customerDetails.phone = phone;

    // Validation: City and State must be English letters only
    if (!/^[A-Za-z\s]+$/.test(customerDetails.city)) {
      throw new Error('City must contain English letters only');
    }
    if (!/^[A-Za-z\s]+$/.test(customerDetails.state)) {
      throw new Error('State must contain English letters only');
    }

    // Validation: Address (alphanumeric + limited special chars)
    if (!/^[A-Za-z0-9\s\*&\/\-\(\)#_+\[\]:'".,]+$/.test(customerDetails.address)) {
      throw new Error('Address contains invalid characters');
    }

    // STEP 1.1: CREATE CUSTOMER
    btn.innerHTML = '<span class="spinner"></span> Creating customer...';
    console.log('Step 1.1: Creating customer...');
    console.log('Phone number:', phone);
    
    const customerResponse = await fetch(`${API_URL}/api/create-customer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: fullName,
        email: customerDetails.email,
        contact: phone,
        notes: {
          source: "Shopify Checkout",
          discount_code: appliedDiscount ? Object.keys(validCodes).find(k => validCodes[k] === appliedDiscount) : 'none'
        }
      })
    });

    const customerData = await customerResponse.json();
    
    if (!customerData.success) {
      throw new Error(customerData.error || 'Customer creation failed');
    }

    console.log('✅ Customer created:', customerData.customer_id);

    // STEP 1.1.5: FETCH HS CODES FOR ALL ITEMS
    btn.innerHTML = '<span class="spinner"></span> Preparing items...';
    console.log('Step 1.1.5: Fetching HS codes for cart items...');
    
    const itemsWithHSCodes = await Promise.all(
      cartData.items.map(async (item) => {
        const hsCode = await getHSCodeAsync(item);
        return {
          ...item,
          fetched_hs_code: hsCode
        };
      })
    );
    
    console.log('✅ HS Codes fetched for all items');

    // STEP 1.2: CREATE ORDER WITH CUSTOMER_ID
    btn.innerHTML = '<span class="spinner"></span> Creating order...';
    console.log('Step 1.2: Creating order...');

    const orderResponse = await fetch(`${API_URL}/api/create-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: amount,
        currency: "INR",
        customer_id: customerData.customer_id,
        customer_details: {
          name: fullName,
          email: customerDetails.email,
          contact: phone,
          shipping_address: {
            line1: customerDetails.address,
            line2: "",
            city: customerDetails.city,
            state: customerDetails.state,
            country: "IND",
            zipcode: customerDetails.zip
          }
        },
        notes: {
          source: "Shopify Import Flow",
          cart_token: cartData.token || "manual",
          discount_applied: appliedDiscount ? Object.keys(validCodes).find(k => validCodes[k] === appliedDiscount) : 'none',
          original_amount: (cartData.total_price / 100).toFixed(2),
          final_amount: amount.toFixed(2),
          product_category: "Women's & Girls' Apparel",
          items_details: itemsWithHSCodes.map(item => ({
            name: item.product_title,
            quantity: item.quantity,
            hs_code: item.fetched_hs_code,
            material: getMaterialDescription(item.product_title),
            category: getProductCategory(item.product_title),
            variant: item.variant_title || 'Standard',
            sku: item.sku || '',
            handle: item.handle || ''
          }))
        }
      })
    });

    const orderData = await orderResponse.json();
    
    if (!orderData.success) {
      throw new Error(orderData.error || 'Order creation failed');
    }

    console.log('✅ Order created:', orderData.order_id);

    // STEP 1.3: OPEN RAZORPAY CHECKOUT
    btn.innerHTML = '<span class="spinner"></span> Opening payment...';
    closeModal();

    const rzpOptions = {
      key: orderData.key_id,
      amount: orderData.amount,
      currency: orderData.currency,
      order_id: orderData.order_id,
      customer_id: customerData.customer_id,
      name: "{{ shop.name }}",
      description: `Order for ${cartData.item_count} item(s)`,
      image: "{{ shop.logo | img_url: 'medium' }}",
      prefill: {
        name: fullName,
        email: customerDetails.email,
        contact: phone
      },
      theme: {
        color: "#0080ff"
      },
      handler: async function(response) {
        // STEP 1.4: SUCCESS HANDLER
        console.log('=== PAYMENT HANDLER TRIGGERED ===');
        console.log('Payment ID:', response.razorpay_payment_id);
        console.log('Order ID:', response.razorpay_order_id);
        console.log('Signature:', response.razorpay_signature);
        console.log('Payment successful, verifying...');
        
        try {
          await verifyPayment(response, customerDetails);
        } catch (error) {
          console.error('❌ VERIFICATION ERROR:', error);
          alert('Payment successful but verification failed.\n\nPayment ID: ' + response.razorpay_payment_id + '\n\nPlease contact support to complete your order.');
        }
      },
      modal: {
        ondismiss: function() {
          // STEP 1.4: CANCEL HANDLER
          console.log('Payment cancelled by user');
          btn.innerHTML = 'Pay Now';
          btn.disabled = false;
          alert('Payment cancelled. Your cart items are still saved.');
        }
      }
    };

    const rzp = new Razorpay(rzpOptions);
    
    // Error handler for Razorpay failures
    rzp.on('payment.failed', function(response) {
      console.error('❌ PAYMENT FAILED:', response.error);
      console.error('Code:', response.error.code);
      console.error('Description:', response.error.description);
      console.error('Reason:', response.error.reason);
      alert(`Payment failed: ${response.error.description || 'Please try again'}`);
      btn.innerHTML = 'Pay Now';
      btn.disabled = false;
    });

    rzp.open();
    
    // FALLBACK: Check payment status after 10 seconds
    setTimeout(async () => {
      console.log('🔍 Fallback: Checking if payment completed without handler...');
      
      try {
        const currentCart = await fetch('/cart.js').then(r => r.json());
        
        if (currentCart.item_count > 0) {
          console.warn('⚠️ Cart still has items 10 seconds after payment initiated.');
          console.warn('If you completed payment, please contact support.');
          console.warn('Order ID:', orderData.order_id);
        } else {
          console.log('✅ Cart is empty - payment likely succeeded');
        }
      } catch (error) {
        console.error('Fallback check error:', error);
      }
    }, 10000);

  } catch (err) {
    console.error('❌ Payment initiation error:', err);
    alert('Error: ' + err.message);
    btn.innerHTML = 'Pay Now';
    btn.disabled = false;
  }
}
