// EmailJS credentials — https://emailjs.com (free, no backend required)
//
// Setup steps:
//  1. Create a free account at https://emailjs.com
//  2. Add an Email Service (Gmail, Outlook, etc.) → copy the Service ID
//  3. Create an Email Template with these variables:
//       {{to_name}}   — recipient's username
//       {{to_email}}  — recipient's email address
//       {{otp_code}}  — the 6-digit verification code
//     Example subject: "Your Yak Battle verification code"
//     Example body:    "Hi {{to_name}}, your code is: {{otp_code}}"
//  4. Copy the Template ID and your account's Public Key (Account → API Keys)
//  5. Fill in the three constants below and save

const EMAILJS_SERVICE_ID  = 'service_27jemc1';
const EMAILJS_TEMPLATE_ID = 'template_7ez14pd';
const EMAILJS_PUBLIC_KEY  = 'J0RYtIUtsU65ZY2F3';
