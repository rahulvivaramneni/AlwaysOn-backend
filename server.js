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
  const { repoUrl } = req.body;

  if (!repoUrl) {
    return res.status(400).json({ error: "Repository URL is required" });
  }

  const cleanedRepoUrl = repoUrl.replace(/\.git$/, "");
  const repoName = path.basename(cleanedRepoUrl);
  const repoPath = path.join(__dirname, repoName);
  const distPath = path.join(repoPath, "dist");

  const repoApiUrl =
    cleanedRepoUrl.replace("github.com", "api.github.com/repos") + "/zipball";

  try {
    // Download the repository as a ZIP file
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
      // Extract the ZIP file
      const directory = await unzipper.Open.file(zipPath);
      await directory.extract({ path: __dirname });

      // Clean up the ZIP file
      fs.unlinkSync(zipPath);

      // Logging to check the contents of the directory after extraction
      const contents = fs.readdirSync(__dirname);
      console.log("Contents of directory after extraction:", contents);

      // Find the extracted folder (GitHub appends a hash to the folder name)
      const extractedFolders = contents.filter(
        (folder) =>
          folder.includes(repoName) &&
          fs.lstatSync(path.join(__dirname, folder)).isDirectory()
      );

      console.log("Extracted Folders:", extractedFolders);

      if (extractedFolders.length === 0) {
        console.error("No extracted folder found");
        return res.status(500).json({ error: "No extracted folder found" });
      }

      const extractedFolder = extractedFolders[0];
      const extractedPath = path.join(__dirname, extractedFolder);

      console.log("Extracted Folder:", extractedFolder);

      // Move extracted contents to the final repository path
      fs.renameSync(extractedPath, repoPath);

      // Proceed with the deployment process
      process.chdir(repoPath);

      const hasPackageJson = fs.existsSync(path.join(repoPath, "package.json"));
      if (hasPackageJson) {
        exec("npm install && npm run build", (error, stdout, stderr) => {
          if (error) {
            console.error("Build error:", error);
            console.error("Build stderr:", stderr);
            return res.status(500).json({ error: "Build failed" });
          }

          console.log("Build stdout:", stdout);

          if (!fs.existsSync(distPath)) {
            fs.mkdirSync(distPath);
          }

          fs.readdirSync("build").forEach((file) => {
            fs.renameSync(path.join("build", file), path.join(distPath, file));
          });

          deployToArweave(res, repoPath);
        });
      } else {
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
        deployToArweave(res, repoPath);
      }
    });

    writer.on("error", (error) => {
      console.error("Error writing ZIP file:", error);
      res.status(500).json({ error: "Failed to download repository" });
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Deployment process failed" });
  }
});

function deployToArweave(res, repoPath) {
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

      fs.rmSync(repoPath, {
        recursive: true,
        force: true,
      });
    }
  );
}

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
