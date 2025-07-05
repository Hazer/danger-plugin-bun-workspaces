import "./danger/sdk";
import {
  bunLockfilesPlugin,
  type BunLockPluginOptions,
} from "./bunLockfilesPlugin";

async function bunWorkspaceChecks(packageOptions: BunLockPluginOptions) {
  // Replace this with the code from your Dangerfile
  // const title = danger.github.pr.title;
  // message(`PR Title: ${title}`);

  await bunLockfilesPlugin(packageOptions);
}

export { bunLockfilesPlugin, bunWorkspaceChecks, type BunLockPluginOptions };
