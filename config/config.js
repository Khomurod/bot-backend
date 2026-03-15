require('dotenv').config();

module.exports = {
  botToken: process.env.BOT_TOKEN,
  databaseUrl: process.env.DATABASE_URL,
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  managementGroupId: process.env.MANAGEMENT_GROUP_ID || '-5275569828',
  jwtSecret: process.env.JWT_SECRET || 'driver-feedback-jwt-secret-key',
  port: process.env.PORT || 3001,
};
