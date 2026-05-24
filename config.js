require("dotenv").config();

const OutlineServer = require("./models/OutlineServer");

const REGION_LABELS = {
  SG: "Singapore",
  JP: "Japan",
  KR: "Korea",
  TH: "Thailand",
  US: "United States"
};

const PLANS = {
  "50": { price: 3000, gb: 50 },
  "100": { price: 5000, gb: 100 },
  "200": { price: 7000, gb: 200 },
  "500": { price: 15000, gb: 500 }
};

const serverIndex = {};
let seedPromise;

function envServers() {
  return [
    { region: "SG", name: "Singapore 1", apiUrl: process.env.SG_API_1 },
    { region: "SG", name: "Singapore 2", apiUrl: process.env.SG_API_2 },
    { region: "JP", name: "Japan 1", apiUrl: process.env.JP_API_1 },
    { region: "JP", name: "Japan 2", apiUrl: process.env.JP_API_2 },
    { region: "KR", name: "Korea", apiUrl: process.env.KR_API },
    { region: "TH", name: "Thailand", apiUrl: process.env.TH_API },
    { region: "US", name: "United States", apiUrl: process.env.US_API }
  ].filter(server => server.apiUrl);
}

async function seedDefaultServers() {
  if (!seedPromise) {
    seedPromise = (async () => {
      const count = await OutlineServer.countDocuments();
      if (count > 0) return;

      const servers = envServers();
      for (const server of servers) {
        await OutlineServer.updateOne(
          { region: server.region, apiUrl: server.apiUrl },
          { $setOnInsert: server },
          { upsert: true }
        );
      }
    })();
  }

  return seedPromise;
}

async function listServers() {
  await seedDefaultServers();
  return OutlineServer.find().sort({ region: 1, name: 1 }).lean();
}

async function listRegions() {
  const servers = await listServers();
  const regions = [...new Set(servers.map(server => server.region))];

  return regions.map(region => ({
    code: region,
    label: REGION_LABELS[region] || region
  }));
}

async function getServer(region) {
  await seedDefaultServers();
  if (!serverIndex[region]) serverIndex[region] = 0;

  const list = await OutlineServer
    .find({ region: String(region).toUpperCase() })
    .sort({ name: 1 })
    .lean();

  if (list.length === 0) {
    throw new Error(`No Outline servers configured for region ${region}`);
  }

  const server = list[serverIndex[region] % list.length];

  serverIndex[region] =
    (serverIndex[region] + 1) % list.length;

  return server.apiUrl;
}

module.exports = {
  PLANS,
  REGION_LABELS,
  getServer,
  listRegions,
  listServers,
  seedDefaultServers
};
