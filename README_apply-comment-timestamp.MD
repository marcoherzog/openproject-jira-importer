# 📌 apply-comment-timestamps — Usage Guide

This script updates comment timestamps inside **OpenProject’s PostgreSQL database** after the Jira → OpenProject migration.  
Because comments are created through the API, OpenProject assigns the current timestamp instead of the original Jira comment date.  
This utility corrects that by restoring the **original Jira timestamps**.

---

# 🧩 1. During Migration: Timestamp File Creation

When running the main migration (`node migrate.js`), comment timestamps are automatically collected.

Example console output:

```
Saved 2 comment timestamps.
```

After the migration, a file is created:

```
comment-timestamps.json
```

Example:

```json
[
  {
    "journal_id": 21,
    "jira_comment_id": "19995",
    "created_at": "2025-11-25T15:16:21.173+0100"
  },
  {
    "journal_id": 23,
    "jira_comment_id": "20064",
    "created_at": "2025-11-26T15:07:25.152+0100"
  }
]
```

Each entry links:

- `journal_id` → The OpenProject journal entry  
- `created_at` → Original Jira comment timestamp  

---

# 🐳 2. Copy Files into the PostgreSQL Docker Container

Since the PostgreSQL container has direct DB access, the script must run **inside** that container.

Copy both files into `/tmp` of the container:

```bash
docker cp apply-comment-timestamps.js openproject-postgres:/tmp/
docker cp comment-timestamps.json openproject-postgres:/tmp/
```

---

# 📦 3. Install Node.js + Dependencies (inside the container)

Enter the PostgreSQL container:

```bash
docker exec -it openproject-postgres bash
```

Inside:

```bash
cd /tmp/
npm init -y
npm install pg
```

This installs the required PostgreSQL client library.

---

# 🔧 4. Configure Database Environment Variables

Inside the container:

```bash
export OP_DB_HOST=localhost
export OP_DB_NAME=openproject
export OP_DB_USER=openproject
export OP_DB_PASS=YOUR_POSTGRES_PASSWORD
export OP_DB_PORT=5432
```

Use your actual DB password from `docker-compose.yml`.

---

# ▶️ 5. Execute the Script

Inside `/tmp`:

```bash
node apply-comment-timestamps.js
```

Expected output:

```
Connecting to PostgreSQL...
Reading comment-timestamps.json...
Updating journal_id 21 → created_at = 2025-11-25T15:16:21.173+0100
Updating journal_id 23 → created_at = 2025-11-26T15:07:25.152+0100
Done. Closing connection.
```

This confirms that timestamps were updated.

---

# 🧹 6. (Optional) Verify via psql

Inside the container:

```bash
psql -U openproject -d openproject
```

Query the affected journal entries:

```sql
SELECT id, journable_id, journable_type, created_at
FROM journals
WHERE id IN (21, 23);
```

Result should show the corrected timestamps.

---

# 🔄 7. Refresh OpenProject UI

Clear OpenProject caches by restarting the container:

```bash
docker restart openproject
```

Your comments should now display the correct historical dates from Jira.

---

# 🎉 Done!

You have successfully restored all Jira comment timestamps in OpenProject.

If you’d like:
- an automated version for all projects  
- a rollback script  
- a version that validates missing journal entries  

just let me know!
