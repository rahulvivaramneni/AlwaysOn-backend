const express = require("express");
const { exec } = require("child_process");
const axios = require("axios");
const unzipper = require("unzipper");
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
  let repoUrl;
  let logs = "";

  if (req.headers["x-github-event"] === "push") {
    // Handle GitHub webhook payload
    repoUrl = req.body.repository.clone_url;
    logs += "GitHub webhook event detected.\n";
    console.log("GitHub webhook event detected.");
  } else {
    // Handle manual deployment request
    repoUrl = req.body.repoUrl;
    logs += "Deployment request received.\n";
    console.log("Deployment request received.");
  }

  if (!repoUrl) {
    logs += "Repository URL is missing.\n";
    console.log("Repository URL is missing.");
    return res.status(400).json({ error: "Repository URL is required", logs });
  }

  const cleanedRepoUrl = repoUrl.replace(/\.git$/, "");
  const repoName = path.basename(cleanedRepoUrl);
  const repoPath = path.join(__dirname, repoName);
  const distPath = path.join(repoPath, "dist");

  const repoApiUrl =
    cleanedRepoUrl.replace("github.com", "api.github.com/repos") + "/zipball";

  try {
    // Download the repository as a ZIP file
    logs += `Downloading repository from ${repoApiUrl}.\n`;
    console.log(`Downloading repository from ${repoApiUrl}.`);
    const response = await axios({
      url: repoApiUrl,
      method: "GET",
      responseType: "stream",
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `token ${process.env.GITHUB_TOKEN}`,
      },
    });

    // Create a write stream to save the ZIP file
    const zipPath = path.join(__dirname, `${repoName}.zip`);
    const writer = fs.createWriteStream(zipPath);

    response.data.pipe(writer);

    writer.on("finish", async () => {
      logs += `Repository downloaded to ${zipPath}.\n`;
      console.log(`Repository downloaded to ${zipPath}.`);

      // Extract the ZIP file
      logs += `Extracting repository.\n`;
      console.log("Extracting repository.");
      const directory = await unzipper.Open.file(zipPath);
      await directory.extract({ path: __dirname });

      // Clean up the ZIP file
      fs.unlinkSync(zipPath);
      logs += "ZIP file cleaned up.\n";
      console.log("ZIP file cleaned up.");

      // Logging to check the contents of the directory after extraction
      const contents = fs.readdirSync(__dirname);
      logs += `Contents of directory after extraction: ${contents.join(
        ", "
      )}.\n`;
      console.log(
        `Contents of directory after extraction: ${contents.join(", ")}.`
      );

      // Find the extracted folder (GitHub appends a hash to the folder name)
      const extractedFolders = contents.filter(
        (folder) =>
          folder.includes(repoName) &&
          fs.lstatSync(path.join(__dirname, folder)).isDirectory()
      );

      logs += `Extracted Folders: ${extractedFolders.join(", ")}.\n`;
      console.log(`Extracted Folders: ${extractedFolders.join(", ")}.`);

      if (extractedFolders.length === 0) {
        logs += "No extracted folder found.\n";
        console.log("No extracted folder found.");
        return res
          .status(500)
          .json({ error: "No extracted folder found", logs });
      }

      const extractedFolder = extractedFolders[0];
      const extractedPath = path.join(__dirname, extractedFolder);
      logs += `Extracted Folder: ${extractedFolder}.\n`;
      console.log(`Extracted Folder: ${extractedFolder}.`);

      // Move extracted contents to the final repository path
      fs.renameSync(extractedPath, repoPath);
      logs += `Repository moved to ${repoPath}.\n`;
      console.log(`Repository moved to ${repoPath}.`);

      // Proceed with the deployment process
      process.chdir(repoPath);

      // Check if a build step is required
      const hasPackageJson = fs.existsSync(path.join(repoPath, "package.json"));
      if (hasPackageJson) {
        logs +=
          "package.json found. Installing dependencies and building project.\n";
        console.log(
          "package.json found. Installing dependencies and building project."
        );
        exec("npm install && npm run build", (error, stdout, stderr) => {
          if (error) {
            logs += `Build error: ${error}\nBuild stderr: ${stderr}\n`;
            console.log(`Build error: ${error}\nBuild stderr: ${stderr}`);
            return res.status(500).json({ error: "Build failed", logs });
          }

          logs += `Build stdout: ${stdout}\n`;
          console.log(`Build stdout: ${stdout}`);

          // Create dist folder if it does not exist
          if (!fs.existsSync(distPath)) {
            fs.mkdirSync(distPath);
          }

          // Move build files to dist folder
          fs.readdirSync("build").forEach((file) => {
            fs.renameSync(path.join("build", file), path.join(distPath, file));
          });

          deployToArweave(res, repoPath, logs);
        });
      } else {
        logs += "package.json not found. Deploying static site.\n";
        console.log("package.json not found. Deploying static site.");
        if (!fs.existsSync(distPath)) {
          fs.mkdirSync(distPath);
        }

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
        deployToArweave(res, repoPath, logs);
      }
    });

    writer.on("error", (error) => {
      logs += `Error writing ZIP file: ${error}\n`;
      console.log(`Error writing ZIP file: ${error}`);
      res.status(500).json({ error: "Failed to download repository", logs });
    });
  } catch (error) {
    logs += `Error: ${error}\n`;
    console.log(`Error: ${error}`);
    res.status(500).json({ error: "Deployment process failed", logs });
  }
});

function deployToArweave(res, repoPath, logs) {
  exec(
    `npx permaweb-deploy --ant-process ${ANT_PROCESS_KEY}`,
    (error, stdout, stderr) => {
      if (error) {
        logs += `Deployment error: ${error}\nDeployment stderr: ${stderr}\n`;
        console.log(`Deployment error: ${error}\nDeployment stderr: ${stderr}`);
        return res.status(500).json({ error: "Deployment failed", logs });
      }

      logs += `Deployment stdout: ${stdout}\nDeployment stderr: ${stderr}\n`;
      console.log(`Deployment stdout: ${stdout}\nDeployment stderr: ${stderr}`);

      const match = stdout.match(/Bundle TxId \[(.+)\]/);
      const txId = match ? match[1] : null;
      if (!txId) {
        logs += "Failed to retrieve transaction ID from output.\n";
        console.log("Failed to retrieve transaction ID from output.");
        return res
          .status(500)
          .json({ error: "Failed to retrieve transaction ID", logs });
      }

      const deployUrl = `https://arweave.net/${txId}`;
      logs += `Deployment successful. URL: ${deployUrl}\n`;
      console.log(`Deployment successful. URL: ${deployUrl}`);
      res.json({ deployUrl, logs });

      // Clean up the cloned repository
      fs.rmSync(repoPath, {
        recursive: true,
        force: true,
      });
      logs += `Repository cleaned up.\n`;
      console.log(`Repository cleaned up.`);
    }
  );
}

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
