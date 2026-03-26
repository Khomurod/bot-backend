require('dotenv').config();

if (!process.env.JWT_SECRET) {
  console.warn('[CONFIG] WARNING: JWT_SECRET is not set. Using an insecure default. Set JWT_SECRET in production!');
}

module.exports = {
  botToken: process.env.BOT_TOKEN,
  databaseUrl: process.env.DATABASE_URL,
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  managementGroupId: process.env.MANAGEMENT_GROUP_ID,
  jwtSecret: process.env.JWT_SECRET || 'driver-feedback-jwt-secret-key-NOT-FOR-PRODUCTION',
  port: process.env.PORT || 3001,
  openaiApiKey: process.env.OPENAI_API_KEY,
  employeeGroupId: process.env.EMPLOYEE_GROUP_ID,
};
