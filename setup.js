// setup.js - External script for setup.html (CSP compliant)

const form = document.getElementById('configForm');
const status = document.getElementById('status');
const currentConfig = document.getElementById('currentConfig');
const loadBtn = document.getElementById('loadBtn');

// Load current configuration
loadBtn.addEventListener('click', async () => {
  try {
    const result = await chrome.storage.local.get(['api_config']);
    if (result.api_config) {
      const config = result.api_config;
      currentConfig.style.display = 'block';
      currentConfig.innerHTML = `
        <strong>Current Configuration:</strong><br>
        Supabase URL: ${config.supabaseUrl ? '✅ Set' : '❌ Missing'}<br>
        Supabase Key: ${config.supabaseKey ? '✅ Set (' + config.supabaseKey.substring(0, 20) + '...)' : '❌ Missing'}<br>
        OpenAI Key: ${config.openaiKey ? '✅ Set (' + config.openaiKey.substring(0, 15) + '...)' : '❌ Missing'}<br>
        Query Transformation: ${config.disableQueryTransformation ? '❌ Disabled (Phase 1 fix)' : '✅ Enabled'}
      `;

      // Populate form fields
      if (config.supabaseUrl) document.getElementById('supabaseUrl').value = config.supabaseUrl;
      if (config.supabaseKey) document.getElementById('supabaseKey').value = config.supabaseKey;
      if (config.openaiKey) document.getElementById('openaiKey').value = config.openaiKey;
      // Phase 1 Fix: Default to true (enabled) for semantic search fix
      document.getElementById('disableQueryTransformation').checked = 
        config.disableQueryTransformation !== undefined ? config.disableQueryTransformation : true;
    } else {
      // Phase 1 Fix: Pre-check checkbox for new users (semantic search fix enabled by default)
      document.getElementById('disableQueryTransformation').checked = true;
      showStatus('No configuration found. Please enter your API keys.', 'error');
    }
  } catch (error) {
    showStatus('Error loading config: ' + error.message, 'error');
  }
});

// Save configuration
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const config = {
    supabaseUrl: document.getElementById('supabaseUrl').value.trim(),
    supabaseKey: document.getElementById('supabaseKey').value.trim(),
    openaiKey: document.getElementById('openaiKey').value.trim(),
    disableQueryTransformation: document.getElementById('disableQueryTransformation').checked
  };

  try {
    await chrome.storage.local.set({ api_config: config });
    showStatus('✅ Configuration saved successfully!', 'success');

    // Show what was saved (partially redacted)
    currentConfig.style.display = 'block';
    currentConfig.innerHTML = `
      <strong>Saved Configuration:</strong><br>
      Supabase URL: ${config.supabaseUrl}<br>
      Supabase Key: ${config.supabaseKey.substring(0, 20)}...<br>
      OpenAI Key: ${config.openaiKey.substring(0, 15)}...<br>
      Query Transformation: ${config.disableQueryTransformation ? '❌ Disabled (Phase 1 fix)' : '✅ Enabled'}
    `;
  } catch (error) {
    showStatus('❌ Error saving configuration: ' + error.message, 'error');
  }
});

function showStatus(message, type) {
  status.textContent = message;
  status.className = 'status ' + type;
  status.style.display = 'block';

  if (type === 'success') {
    setTimeout(() => {
      status.style.display = 'none';
    }, 5000);
  }
}

// Auto-load on page load
window.addEventListener('load', () => {
  loadBtn.click();
});
