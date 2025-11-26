require("dotenv").config();

/**
 * Collects user logins + API keys from environment variables.
 *
 * Example:
 *   OP_LOGIN_USER_4="marcoherzog"
 *   OP_API_KEY_USER_4="xxx"
 *
 * Creates:
 *   {
 *     4: { login: "marcoherzog", apiKey: "xxx" }
 *   }
 */

const users = {};

for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("OP_API_KEY_USER_")) {
        const id = key.replace("OP_API_KEY_USER_", "");
        const numericId = Number(id);
        if (!isNaN(numericId)) {
            if (!users[numericId]) users[numericId] = {};
            users[numericId].apiKey = value;
        }
    }

    if (key.startsWith("OP_LOGIN_USER_")) {
        const id = key.replace("OP_LOGIN_USER_", "");
        const numericId = Number(id);
        if (!isNaN(numericId)) {
            if (!users[numericId]) users[numericId] = {};
            users[numericId].login = value;
        }
    }
}

module.exports = users;