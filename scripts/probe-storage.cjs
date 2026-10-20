// One-off probe: does safeStorage survive a restart on this machine?
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.whenReady().then(() => {
  const mode = process.argv[process.argv.length - 1];
  const file = path.join(app.getPath("userData"), "probe.bin");
  console.log("mode", mode, "available", safeStorage.isEncryptionAvailable());
  if (mode === "write") {
    const sealed = safeStorage.encryptString("hello-river");
    fs.writeFileSync(file, sealed);
    console.log("wrote", sealed.length, "prefix", sealed.subarray(0, 3).toString());
    try {
      console.log("roundtrip", safeStorage.decryptString(sealed));
    } catch (error) {
      console.log("roundtrip-failed", error.message);
    }
  } else {
    try {
      console.log("read", safeStorage.decryptString(fs.readFileSync(file)));
    } catch (error) {
      console.log("FAILED", error.message);
    }
  }
  app.quit();
});
