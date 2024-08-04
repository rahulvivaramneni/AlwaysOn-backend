const express = require("express");
const { exec } = require("child_process");
const simpleGit = require("simple-git");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5001;
const DEPLOY_KEY = process.env.DEPLOY_KEY;
const ANT_PROCESS_KEY = process.env.ANT_PROCESS_KEY;

app.use(cors());
app.use(express.json());

app.post("/deploy", async (req, res) => {
  const { repoUrl } = req.body;

  if (!repoUrl) {
    return res.status(400).json({ error: "Repository URL is required" });
  }

  const repoName = path.basename(repoUrl, ".git");
  const repoPath = path.join(__dirname, repoName);
  const distPath = path.join(repoPath, "dist");

  try {
    // Clone the repository
    await simpleGit().clone(repoUrl, repoPath);

    // Change directory to the cloned repository
    process.chdir(repoPath);

    // Check if a build step is required
    const hasPackageJson = fs.existsSync(path.join(repoPath, "package.json"));
    if (hasPackageJson) {
      // If package.json exists, assume the project has a build step
      exec("npm install && npm run build", (error, stdout, stderr) => {
        if (error) {
          console.error("Build error:", error);
          console.error("Build stderr:", stderr);
          return res.status(500).json({ error: "Build failed" });
        }

        console.log("Build stdout:", stdout);

        // Create dist folder if it does not exist
        if (!fs.existsSync(distPath)) {
          fs.mkdirSync(distPath);
        }

        // Move build files to dist folder
        fs.readdirSync("build").forEach((file) => {
          fs.renameSync(path.join("build", file), path.join(distPath, file));
        });

        // Deploy to Arweave using permaweb-deploy
        deployToArweave(res);
      });
    } else {
      // No package.json, so assume it's a static site
      // Create dist folder if it does not exist
      console.log("disPath", distPath);
      if (!fs.existsSync(distPath)) {
        fs.mkdirSync(distPath);
      }

      console.log("repoPath", repoPath);

      // Move static files to dist folder
      fs.readdirSync(repoPath).forEach((file) => {
        const srcPath = path.join(repoPath, file);
        const destPath = path.join(distPath, file);

        if (file !== "dist" && file !== ".git") {
          if (fs.lstatSync(srcPath).isDirectory()) {
            fs.renameSync(srcPath, destPath);
          } else {
            fs.renameSync(srcPath, destPath);
          }
        }
      });
      // Deploy to Arweave using permaweb-deploy
      deployToArweave(res);
    }
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Deployment process failed" });
  }
});

function deployToArweave(res) {
  exec(
    `npx permaweb-deploy --ant-process ${ANT_PROCESS_KEY}`,
    (error, stdout, stderr) => {
      if (error) {
        console.error("Deployment error:", error);
        console.error("Deployment stderr:", stderr);
        return res.status(500).json({ error: "Deployment failed" });
      }

      console.log("Deployment stdout:", stdout);
      console.log("Deployment stderr:", stderr);

      const match = stdout.match(/Bundle TxId \[(.+)\]/);
      const txId = match ? match[1] : null;
      if (!txId) {
        console.error("Failed to retrieve transaction ID from output.");
        return res
          .status(500)
          .json({ error: "Failed to retrieve transaction ID" });
      }

      const deployUrl = `https://arweave.net/${txId}`;
      res.json({ deployUrl });

      // Clean up the cloned repository
      fs.rmSync(path.join(__dirname, path.basename(repoUrl, ".git")), {
        recursive: true,
        force: true,
      });
    }
  );
}

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
