#!/usr/bin/env node
require("dotenv").config();

const { execSync } = require("child_process");

const { listProjects } = require("./jira-client");
const { listProjects: listOpenProjectProjects } = require("./openproject-client");
const {migrateIssues} = require("./index");

(async function migrateAll() {
    console.log("Fetching Jira projects...");
    const jiraProjects = await listProjects();

    console.log("Fetching OpenProject projects...");
    const openProjects = await listOpenProjectProjects();

    // Mapping: Jira project key === OpenProject project name
    const opProjectMap = {};
    for (const op of openProjects) {
        opProjectMap[op.name.toUpperCase()] = op.id;
    }

    console.log("\nStarting full migration of ALL projects...\n");

    //
    // 1) Migrate issues
    //
    for (const jiraProject of jiraProjects) {
        const key = jiraProject.key.toUpperCase();

        if (!opProjectMap[key]) {
            console.log(`❌ No matching OpenProject project found for ${key}, skipping`);
            continue;
        }

        const openProjectId = opProjectMap[key];

        console.log(`\n------------------------------------------`);
        console.log(`🚀 Migrating Jira project ${key} → OP ${openProjectId}`);
        console.log(`------------------------------------------`);

        try {
            await migrateIssues(
                key,         // jiraProject
                openProjectId,
                true,        // isProd
                null,        // specific issues
                true,        // skipUpdates = skip existing
                true,        // mapResponsible
                { forceUseExistingMapping: true } // added argument to auto-confirm mapping
            );

            console.log(`✅ Finished migrating ${key}`);
        } catch (err) {
            console.error(`❌ Migration failed for ${key}:`, err.message);
        }
    }

    //
    // 2) Migrate parents
    //
    for (const jiraProject of jiraProjects) {
        const key = jiraProject.key.toUpperCase();
        const openProjectId = opProjectMap[key];
        if (!openProjectId) continue;

        console.log(`\n📌 Migrating parents for ${key}`);

        execSync(`node migrate-parents.js ${key} ${openProjectId}`, {
            stdio: "inherit"
        });
    }

    //
    // 3) Migrate relationships
    //
    for (const jiraProject of jiraProjects) {
        const key = jiraProject.key.toUpperCase();
        const openProjectId = opProjectMap[key];
        if (!openProjectId) continue;

        console.log(`\n🔗 Migrating relationships for ${key}`);

        execSync(`node migrate-relationships.js ${key} ${openProjectId}`, {
            stdio: "inherit"
        });
    }

    console.log("\n🎉 Migration of all projects completed.\n");
})();