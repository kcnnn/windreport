const form = document.getElementById("search-form");
const addressInput = document.getElementById("address-input");
const statusEl = document.getElementById("status");
const resultsList = document.getElementById("results-list");
const searchButton = document.getElementById("search-button");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const address = addressInput.value.trim();
  if (!address) {
    statusEl.textContent = "Please enter an address.";
    return;
  }

  setLoading(true);
  statusEl.textContent = "Searching NOAA storm events...";
  resultsList.innerHTML = "";

  try {
    const response = await fetch(`/api/windstorms?address=${encodeURIComponent(address)}`);
    const payload = await response.json();

    if (!response.ok) {
      statusEl.textContent = payload.error || "Request failed.";
      return;
    }

    statusEl.textContent = `Results for ${payload.address} (${payload.county || "Unknown county"}, ${
      payload.state || "Unknown state"
    })`;

    if (!payload.results || payload.results.length === 0) {
      resultsList.innerHTML = "<li>No wind storm events found in the last 10 years.</li>";
      return;
    }

    payload.results.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = `DATE: ${item.date} - WIND SPEED: ${item.windSpeedMph} MPH`;
      resultsList.appendChild(li);
    });
  } catch (error) {
    statusEl.textContent = "Something went wrong. Please try again.";
    console.error(error);
  } finally {
    setLoading(false);
  }
});

function setLoading(isLoading) {
  searchButton.disabled = isLoading;
  addressInput.disabled = isLoading;
}

