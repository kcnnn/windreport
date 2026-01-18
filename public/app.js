const form = document.getElementById('search-form');
const addressInput = document.getElementById('address-input');
const radiusSelect = document.getElementById('radius-select');
const searchBtn = document.getElementById('search-btn');
const statusEl = document.getElementById('status');
const resultsSection = document.getElementById('results-section');
const resultsList = document.getElementById('results-list');
const eventCount = document.getElementById('event-count');
const locationInfo = document.getElementById('location-info');
const noResults = document.getElementById('no-results');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const address = addressInput.value.trim();
  if (!address) {
    showStatus('Please enter an address.', true);
    return;
  }

  const radius = radiusSelect.value;

  setLoading(true);
  showStatus('Searching NOAA Storm Events database...');
  hideResults();

  try {
    const url = `/api/windstorms?address=${encodeURIComponent(address)}&radius=${radius}`;
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      showStatus(data.error || 'Request failed. Please try again.', true);
      return;
    }

    displayResults(data);
  } catch (err) {
    console.error(err);
    showStatus('Connection error. Please check your network and try again.', true);
  } finally {
    setLoading(false);
  }
});

function setLoading(isLoading) {
  searchBtn.disabled = isLoading;
  addressInput.disabled = isLoading;
  searchBtn.classList.toggle('loading', isLoading);
}

function showStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function hideResults() {
  resultsSection.classList.add('hidden');
  resultsList.innerHTML = '';
}

function displayResults(data) {
  const { address, county, state, radiusMiles, results } = data;

  // Update location info
  const locationParts = [];
  if (county) locationParts.push(county);
  if (state) locationParts.push(state);
  let locationText = locationParts.length > 0 ? `📍 ${locationParts.join(', ')}` : address;
  if (radiusMiles) {
    locationText += ` (within ${radiusMiles} miles)`;
  }
  locationInfo.textContent = locationText;

  // Show results section
  resultsSection.classList.remove('hidden');

  if (!results || results.length === 0) {
    noResults.classList.remove('hidden');
    eventCount.textContent = '0 events';
    const msg = radiusMiles 
      ? `No wind storms found within ${radiusMiles} miles. Try increasing the radius.`
      : 'Search complete.';
    showStatus(msg, false);
    return;
  }

  noResults.classList.add('hidden');
  eventCount.textContent = `${results.length} event${results.length !== 1 ? 's' : ''}`;
  showStatus(`Found ${results.length} wind storm event${results.length !== 1 ? 's' : ''} in the past 10 years.`);

  // Render results
  resultsList.innerHTML = '';
  results.forEach((item, index) => {
    const li = document.createElement('li');
    li.style.animationDelay = `${Math.min(index * 0.03, 0.5)}s`;
    
    const isSevere = item.windSpeedMph >= 75;
    const distanceText = item.distanceMiles !== null ? ` · ${item.distanceMiles} mi away` : '';
    
    li.innerHTML = `
      <span class="date">DATE: ${item.date}</span>
      <span>
        <span class="speed ${isSevere ? 'severe' : ''}">WIND SPEED: ${item.windSpeedMph} MPH</span>
        <span class="event-type">${item.eventType || ''}${distanceText}</span>
      </span>
    `;
    
    resultsList.appendChild(li);
  });
}

// Allow Enter key to submit
addressInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !searchBtn.disabled) {
    form.requestSubmit();
  }
});
