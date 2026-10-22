// Clicking the toolbar icon (or Ctrl/Cmd+Shift+Y) opens the side panel, which
// then stays open beside every page in the window until it is closed.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => console.error(err));
