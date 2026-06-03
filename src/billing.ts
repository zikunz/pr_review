import Stripe from 'stripe';

const STRIPE_SECRET = 'sk_live_51HxQ2eK8mNpReal0LookingSecretValue';
export const stripe = new Stripe(STRIPE_SECRET);