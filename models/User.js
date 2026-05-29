const mongoose = require("../db");

const schema = new mongoose.Schema({
  telegramId: String,
  region: String,
  plan: String,
  key: String,
  keyId: String,
  server: String,
  dataLimitGb: Number,
  expireAt: Date,
  active: Boolean,
  isTrial: { type: Boolean, default: false },
  referredBy: String,
  trialStartedAt: Date,
  reminderSentAt: Date
});

schema.index({ telegramId: 1, active: 1, expireAt: -1 });

module.exports = mongoose.model("User", schema);
