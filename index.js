require("dotenv").config();
const fs = require("fs");
const path = require("path");
const inquirer = require("inquirer");
const {
  getAllJiraIssues,
  getSpecificJiraIssues,
  downloadAttachment,
  listProjects,
  getIssueWatchers,
} = require("./jira-client");
const commentUserMapping = require("./op-user-api-keys");
const { generateMapping } = require("./generate-user-mapping");
const {
  getOpenProjectWorkPackages,
  createWorkPackage,
  updateWorkPackage,
  addComment,
  uploadAttachment,
  getWorkPackageTypes,
  getWorkPackageStatuses,
  getWorkPackageTypeId,
  getWorkPackageStatusId,
  getExistingAttachments,
  getExistingComments,
  getOpenProjectUsers,
  getOpenProjectUserById,
  findExistingWorkPackage,
  JIRA_ID_CUSTOM_FIELD,
  getWorkPackagePriorityId,
  getWorkPackagePriorities,
  addWatcher,
} = require("./openproject-client");

// Create temp directory for attachments if it doesn't exist
const tempDir = path.join(__dirname, "temp");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

let userMapping = null;

async function getOpenProjectUserId(jiraUser) {
  if (!jiraUser) {
    console.log("No Jira user provided");
    return null;
  }

  const openProjectUserId = userMapping[jiraUser.accountId];
  if (openProjectUserId) {
    console.log(
      `Found OpenProject user ID ${openProjectUserId} for Jira user ${jiraUser.displayName}`
    );
    return openProjectUserId;
  }

  console.log(
    `No OpenProject user mapping found for Jira user ${jiraUser.displayName}`
  );
  return null;
}

async function migrateIssues(
  jiraProjectKey,
  openProjectId,
  isProd,
  specificIssues,
  skipUpdates,
  mapResponsible
) {
  console.log(
    `Starting migration for project ${jiraProjectKey} to OpenProject project ${openProjectId}`
  );
  console.log("Production mode:", isProd ? "yes" : "no");
  console.log(
    "Map Jira creator to OpenProject accountable:",
    mapResponsible ? "yes" : "no"
  );

  // Generate or load user mapping
  console.log("\nChecking user mapping...");
  try {
    userMapping = require("./user-mapping");
    const shouldUpdate = await inquirer.prompt([
      {
        type: "confirm",
        name: "update",
        message: "Existing user mapping found. Would you like to update it?",
        default: false,
      },
    ]);
    if (shouldUpdate.update) {
      userMapping = await generateMapping();
    }
  } catch (error) {
    console.log("No existing user mapping found. Generating new mapping...");
    userMapping = await generateMapping();
  }

  // List available projects
  await listProjects();

  // Get work package types and statuses
  await getWorkPackageTypes();
  await getWorkPackageStatuses();
  await getWorkPackagePriorities();
  await getOpenProjectUsers();

  // Cache OpenProject work packages if skipUpdates is enabled
  let openProjectWorkPackagesCache = null;
  if (skipUpdates) {
    console.log("Caching OpenProject work packages...");
    openProjectWorkPackagesCache = await getOpenProjectWorkPackages(
      openProjectId
    );
    console.log(
      `Found ${openProjectWorkPackagesCache.size} work packages in OpenProject`
    );
  }

  // Get Jira issues
  const jiraIssues = specificIssues
    ? await getSpecificJiraIssues(jiraProjectKey, specificIssues)
    : await getAllJiraIssues(jiraProjectKey);

  console.log(`Found ${jiraIssues.length} Jira issues to process`);
  console.log("Issues will be processed in chronological order (oldest first)");

  // Process each issue
  let processed = 0;
  let skipped = 0;
  let errors = 0;
  let unknownStatusCount = 0;
  const issueToWorkPackageMap = new Map();

  for (const issue of jiraIssues) {
    try {
      console.log(`\nProcessing ${issue.key}...`);

      // Check if work package already exists
      let existingWorkPackage = null;
      if (skipUpdates) {
        existingWorkPackage = openProjectWorkPackagesCache.get(issue.key);
      } else {
        existingWorkPackage = await findExistingWorkPackage(
          issue.key,
          openProjectId
        );
      }

      if (existingWorkPackage && skipUpdates) {
        console.log(
          `Skipping ${issue.key} - already exists as work package ${existingWorkPackage.id}`
        );
        issueToWorkPackageMap.set(issue.key, existingWorkPackage.id);
        skipped++;
        continue;
      }

      // Get assignee ID from mapping
      let assigneeId = null;
      let responsibleId = null;
      if (issue.fields.assignee) {
        assigneeId = await getOpenProjectUserId(issue.fields.assignee);
      }
      if (mapResponsible && issue.fields.creator) {
        responsibleId = await getOpenProjectUserId(issue.fields.creator);
      }

      const opStatusId = getWorkPackageStatusId(issue.fields.status.name);
      if (opStatusId === getWorkPackageStatusId("unknown")) {
        unknownStatusCount++;
      }

      // Create work package payload
      const payload = {
        _type: "WorkPackage",
        subject: issue.fields.summary,
        description: {
          format: "html",
          raw: convertAtlassianDocumentToHtml(issue.fields.description),
        },
        _links: {
          type: {
            href: `/api/v3/types/${getWorkPackageTypeId(
              issue.fields.issuetype.name
            )}`,
          },
          status: {
            href: `/api/v3/statuses/${opStatusId}`,
          },
          priority: {
            href: `/api/v3/priorities/${getWorkPackagePriorityId(
              issue.fields.priority
            )}`,
          },
          project: {
            href: `/api/v3/projects/${openProjectId}`,
          },
        },
        [`customField${JIRA_ID_CUSTOM_FIELD}`]: issue.key,
      };

      // Add assignee if available
      if (assigneeId) {
        payload._links.assignee = {
          href: `/api/v3/users/${assigneeId}`,
        };
      }

      // Add responsible (accountable) if available
      if (responsibleId) {
        payload._links.responsible = {
          href: `/api/v3/users/${responsibleId}`,
        };
      }

      let workPackage;
      if (isProd) {
        if (existingWorkPackage) {
          console.log(
            `Updating existing work package ${existingWorkPackage.id}`
          );
          workPackage = await updateWorkPackage(
            existingWorkPackage.id,
            payload
          );
        } else {
          console.log("Creating new work package");
          workPackage = await createWorkPackage(openProjectId, payload);
        }
      } else {
        console.log(
          "[DRY RUN] Would create or update work package with payload:",
          JSON.stringify(payload, null, 2)
        );
        workPackage = {
          id: existingWorkPackage ? existingWorkPackage.id : "DRY_RUN_WP_ID",
        };
      }

      issueToWorkPackageMap.set(issue.key, workPackage.id);

      // Process attachments
      const attachmentIdMap = new Map();
      if (issue.fields.attachment && issue.fields.attachment.length > 0) {
        const existingAttachments = isProd
          ? await getExistingAttachments(workPackage.id)
          : [];
        const existingAttachmentNames = existingAttachments.map(
          (a) => a.fileName
        );

        for (const attachment of issue.fields.attachment) {
          if (existingAttachmentNames.includes(attachment.filename)) {
            console.log(`Skipping existing attachment: ${attachment.filename}`);
            const existing = existingAttachments.find(a => a.fileName === attachment.filename);
            if(existing) {
              attachmentIdMap.set(attachment.filename, existing.id);
            }
            continue;
          }

          console.log(`Processing attachment: ${attachment.filename}`);
          if (isProd) {
            const tempFilePath = path.join(tempDir, attachment.filename);
            await downloadAttachment(attachment.content, tempFilePath);
            const newAttachment = await uploadAttachment(
              workPackage.id,
              tempFilePath,
              attachment.filename
            );
            attachmentIdMap.set(attachment.filename, newAttachment.id);
            fs.unlinkSync(tempFilePath);
          } else {
            console.log(
              `[DRY RUN] Would upload attachment: ${attachment.filename}`
            );
            attachmentIdMap.set(attachment.filename, "DRY_RUN_ATTACHMENT_ID");
          }
        }
      }

      // Finalize description with inline images
      let finalDescription = payload.description.raw;
      if (attachmentIdMap.size > 0) {
        for (const [filename, attachmentId] of attachmentIdMap.entries()) {
          const placeholder = `{{jira-attachment-placeholder:${filename}}}`;
          const imageTag = `<img class="op-uc-image op-uc-image_inline" src="/api/v3/attachments/${attachmentId}/content">`;
          finalDescription = finalDescription.replace(placeholder, imageTag);
        }

        if (finalDescription !== payload.description.raw) {
          console.log("Updating work package with inline images.");
          if (isProd) {
            await updateWorkPackage(workPackage.id, {
              description: {
                format: "html",
                raw: finalDescription,
              },
            });
          } else {
            console.log(
              "[DRY RUN] Would perform second update for description:",
              finalDescription
            );
          }
        }
      }

      // Process comments
      if (issue.fields.comment && issue.fields.comment.comments.length > 0) {
        const existingComments = isProd
          ? await getExistingComments(workPackage.id)
          : [];
        const commentMap = new Map();
        const jiraCommentIdRegex = /<!-- jira-comment-id: (\d+) -->/;

        for (const opComment of existingComments) {
          const match = opComment.comment.raw.match(jiraCommentIdRegex);
          if (match) {
            commentMap.set(match[1], opComment);
          }
        }

        for (const jiraComment of issue.fields.comment.comments) {

          console.log(`jiraComment.author.accountId: ${jiraComment.author.accountId}.`);

          const openProjectUserId = userMapping[jiraComment.author.accountId];

          console.log(`openProjectUserId: ${openProjectUserId}.`);

          const mappedUser = commentUserMapping[openProjectUserId];

          console.log(`mappedUser: ${mappedUser}.`);

          console.log("DEBUG Processing Jira comment:", {
            jiraCommentId: jiraComment.id,
            jiraAuthor: jiraComment.author?.displayName,
            mappedUser: mappedUser
                ? { login: mappedUser.login, hasApiKey: !!mappedUser.apiKey }
                : null
          });

          const opUser = commentUserMapping[openProjectUserId];
          if (commentMap.has(jiraComment.id)) {
            console.log(`Skipping already migrated comment for Jira ID ${jiraComment.id}.`);
            continue;
          }

          let commentHtml = convertAtlassianDocumentToHtml(jiraComment.body);
          if (commentHtml) {
             if (attachmentIdMap.size > 0) {
                for (const [filename, attachmentId] of attachmentIdMap.entries()) {
                    const placeholder = `{{jira-attachment-placeholder:${filename}}}`;
                    const imageTag = `<img class="op-uc-image op-uc-image_inline" src="/api/v3/attachments/${attachmentId}/content">`;
                    commentHtml = commentHtml.replace(placeholder, imageTag);
                }
            }

            const author = jiraComment.author.displayName;
            const date = new Date(jiraComment.created).toLocaleString();
            const fullCommentHtml = `<p><em>${author} wrote on ${date}:</em></p>${commentHtml}<!-- jira-comment-id: ${jiraComment.id} -->`;

            console.log(`Adding new comment for Jira ID ${jiraComment.id}`);
            if (isProd) {
              if (opUser) {
                console.log(`DEBUG: Adding comment as impersonated user: ${opUser.login}`);
                await addCommentAsUser(workPackage.id, fullCommentHtml, opUser);
              } else {
                console.log("DEBUG: No impersonation possible → using default addComment()");
                await addComment(workPackage.id, fullCommentHtml);
              }
            } else {
              console.log(
                `[DRY RUN] Would add new comment:`,
                fullCommentHtml
              );
            }
          }
        }
      }

      // Add watchers if any
      if (issue.fields.watches?.watchCount > 0) {
        console.log("Adding watchers");
        const watchers = await getIssueWatchers(issue.key);
        for (const watcher of watchers.watchers) {
          const watcherId = await getOpenProjectUserId(watcher);
          if (watcherId) {
            if (isProd) {
              await addWatcher(workPackage.id, watcherId);
            } else {
              console.log(
                `[DRY RUN] Would add watcher ${watcherId} to work package ${workPackage.id}`
              );
            }
          }
        }
      }

      processed++;
    } catch (error) {
      console.error(`Error processing ${issue.key}:`, error.message);
      if (error.response?.data) {
        console.error(
          "Error details:",
          JSON.stringify(error.response.data, null, 2)
        );
      }
      errors++;
    }
  }

  // Clean up temp directory
  if (isProd && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true });
  }

  console.log("\nMigration summary:");
  console.log(`Total issues processed: ${processed + skipped}`);
  console.log(`Completed: ${processed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors: ${errors}`);
  console.log(`UNKNOWN statuses assigned: ${unknownStatusCount}`);

  return issueToWorkPackageMap;
}

function convertAtlassianDocumentToHtml(doc) {
  if (!doc) {
    return "";
  }
  if (typeof doc === "string") {
    return `<p>${doc}</p>`;
  }

  function processNode(node) {
    if (!node || !node.type) return "";

    let content = "";
    if (node.content) {
      content = node.content.map(processNode).join("");
    }

    switch (node.type) {
      case "doc":
        return content;
      case "paragraph":
        return `<p>${content || "&nbsp;"}</p>`;
      case "text":
        let text = node.text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        if (node.marks) {
          node.marks.forEach((mark) => {
            if (mark.type === "strong") {
              text = `<strong>${text}</strong>`;
            } else if (mark.type === "em") {
              text = `<em>${text}</em>`;
            } else if (mark.type === "code") {
              text = `<code>${text}</code>`;
            } else if (mark.type === "link") {
              text = `<a href="${mark.attrs.href}">${text}</a>`;
            }
          });
        }
        return text;
      case "bulletList":
        return `<ul>${content}</ul>`;
      case "orderedList":
        return `<ol>${content}</ol>`;
      case "listItem":
        return `<li>${content}</li>`;
      case "heading":
        const level = node.attrs.level || 1;
        return `<h${level}>${content}</h${level}>`;
      case "codeBlock":
        return `<pre><code>${content}</code></pre>`;
      case "blockquote":
        return `<blockquote>${content}</blockquote>`;
      case "hardBreak":
        return "<br />";
      case "table":
        return `<table><tbody>${content}</tbody></table>`;
      case "tableRow":
        return `<tr>${content}</tr>`;
      case "tableHeader":
        return `<th>${content}</th>`;
      case "tableCell":
        return `<td>${content}</td>`;
      case "mediaSingle":
        return `<p>${content}</p>`;
      case "media":
        if (node.attrs.type === "file" && node.attrs.alt) {
          return `{{jira-attachment-placeholder:${node.attrs.alt}}}`;
        }
        return "";
      default:
        return content;
    }
  }

  return processNode(doc);
}

async function addCommentAsUser(workPackageId, commentHtml, opUser) {

  console.log("DEBUG addCommentAsUser():", {
    workPackageId,
    login: opUser?.login,
    apiKeyExists: !!opUser?.apiKey
  });

  const axios = require("axios");
  const authString = Buffer.from(`apikey:${opUser.apiKey}`).toString("base64");
  const client = axios.create({
    baseURL: process.env.OPENPROJECT_HOST,
    headers: {
      Authorization: `Basic ${authString}`,
      "Content-Type": "application/json"
    }
  });

  console.log("DEBUG addCommentAsUser(): Using auth user:", opUser.login);

  return client.post(`/api/v3/work_packages/${workPackageId}/activities`, {
    comment: { format: "html", raw: commentHtml }
  });
}

module.exports = {
  migrateIssues,
};
