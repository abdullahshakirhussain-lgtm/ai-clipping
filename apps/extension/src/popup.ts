// Minimal popup: surface the most recent post status the background recorded.
chrome.storage.session.get("lastStatus").then((s) => {
  const last = s.lastStatus as string | undefined;
  const el = document.getElementById("last");
  if (el && last) el.textContent = last;
});
