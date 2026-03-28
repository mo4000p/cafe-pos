/**
 * seed-customers.js
 * Run once to create test Stripe customers with phone + card on file.
 * Usage: node seed-customers.js
 */
import Stripe from 'stripe';
import 'dotenv/config';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const TEST_CUSTOMERS = [
  { name: 'Jane Smith',   phone: '+13125550101' },
  { name: 'Carlos Rivera', phone: '+13125550102' },
  { name: 'Priya Nair',   phone: '+13125550103' },
];

for (const c of TEST_CUSTOMERS) {
  const customer = await stripe.customers.create({
    name: c.name,
    phone: c.phone,
    metadata: { phone: c.phone },
  });

  const pm = await stripe.paymentMethods.create({
    type: 'card',
    card: { token: 'tok_visa' },
  });

  await stripe.paymentMethods.attach(pm.id, { customer: customer.id });
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: pm.id },
  });

  console.log(`Created: ${c.name} | ${customer.id} | ${c.phone} | ${pm.id}`);
}

console.log('\nDone. Customers are ready in Stripe sandbox.');