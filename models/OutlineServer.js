const mongoose = require("../db");

const schema = new mongoose.Schema({
  region: { type: String, required: true, uppercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  apiUrl: { type: String, required: true, trim: true },
  createdAt: { type: Date, default: Date.now }
});

schema.index({ region: 1, apiUrl: 1 }, { unique: true });

module.exports = mongoose.model("OutlineServer", schema);
