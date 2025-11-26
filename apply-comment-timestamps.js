const { Client } = require("pg");
const fs = require("fs");

// ---- CONFIG ----
const DB_HOST = process.env.OP_DB_HOST || "localhost";
const DB_NAME = process.env.OP_DB_NAME || "openproject";
const DB_USER = process.env.OP_DB_USER || "openproject";
const DB_PASS = process.env.OP_DB_PASS || "";
const DB_PORT = process.env.OP_DB_PORT || 5432;

(async function () {
    const client = new Client({
        host: DB_HOST,
        port: DB_PORT,
        user: DB_USER,
        password: DB_PASS,
        database: DB_NAME,
    });

    console.log("Connecting to PostgreSQL...");
    await client.connect();

    console.log("Reading comment-timestamps.json...");
    const data = JSON.parse(fs.readFileSync("./comment-timestamps.json", "utf8"));

    for (const entry of data) {
        const { journal_id, created_at } = entry;

        if (!journal_id || !created_at) {
            console.log(`Skipping invalid entry:`, entry);
            continue;
        }

        console.log(
            `Updating journal_id ${journal_id} → created_at = ${created_at}`
        );

        try {
            await client.query(
                `
        UPDATE journals
        SET created_at = $1
        WHERE id = $2;
      `,
                [created_at, journal_id]
            );
        } catch (err) {
            console.error(
                `Error updating journal ${journal_id}:`,
                err.message
            );
        }
    }

    console.log("Done. Closing connection.");
    await client.end();
    process.exit(0);
})();
