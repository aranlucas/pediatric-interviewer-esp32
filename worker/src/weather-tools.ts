const WEATHER_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const AIR_ENDPOINT = "https://air-quality-api.open-meteo.com/v1/air-quality";
const REQUEST_TIMEOUT_MS = 10_000;

export type WeatherLocation = {
  name: string;
  latitude: number;
  longitude: number;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} was missing from Open-Meteo`);
  }
  return value as JsonRecord;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} was missing from Open-Meteo`);
  }
  return value;
}

function numberArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "number")) {
    throw new Error(`${label} was missing from Open-Meteo`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} was missing from Open-Meteo`);
  }
  return value;
}

async function fetchJson(url: URL): Promise<JsonRecord> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Open-Meteo returned HTTP ${response.status}`);
  }
  return record(await response.json(), "response");
}

function weatherUrl(
  location: WeatherLocation,
  fields: { current?: string; daily: string; days: number },
): URL {
  const url = new URL(WEATHER_ENDPOINT);
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  if (fields.current) url.searchParams.set("current", fields.current);
  url.searchParams.set("daily", fields.daily);
  url.searchParams.set("temperature_unit", "fahrenheit");
  if (fields.current) url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", String(fields.days));
  return url;
}

export function weatherCondition(code: number): string {
  if (code === 0) return "Clear";
  if (code === 1) return "Mostly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Cloudy";
  if (code === 45 || code === 48) return "Foggy";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Rain showers";
  if (code >= 85 && code <= 86) return "Snow showers";
  if (code >= 95) return "Thunderstorms";
  return "Unavailable";
}

export function airQualityCategory(aqi: number): string {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for sensitive groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very unhealthy";
  return "Hazardous";
}

export async function getCurrentWeather(location: WeatherLocation) {
  const payload = await fetchJson(
    weatherUrl(location, {
      current:
        "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m,is_day",
      daily:
        "temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,sunset",
      days: 1,
    }),
  );
  const current = record(payload.current, "current weather");
  const daily = record(payload.daily, "daily weather");
  const highs = numberArray(daily.temperature_2m_max, "daily high");
  const lows = numberArray(daily.temperature_2m_min, "daily low");
  const rain = numberArray(daily.precipitation_probability_max, "precipitation probability");
  const uv = numberArray(daily.uv_index_max, "UV index");
  const sunsets = stringArray(daily.sunset, "sunset");
  const code = finiteNumber(current.weather_code, "weather code");

  return {
    source: "Open-Meteo live server tool",
    location: location.name,
    observedAt: String(current.time ?? "now"),
    condition: weatherCondition(code),
    temperatureF: finiteNumber(current.temperature_2m, "temperature"),
    feelsLikeF: finiteNumber(current.apparent_temperature, "apparent temperature"),
    highF: highs[0],
    lowF: lows[0],
    humidityPercent: finiteNumber(current.relative_humidity_2m, "humidity"),
    windMph: finiteNumber(current.wind_speed_10m, "wind speed"),
    gustMph: finiteNumber(current.wind_gusts_10m, "wind gust"),
    precipitationProbabilityPercent: rain[0],
    uvIndexMax: uv[0],
    sunset: sunsets[0],
    isDay: finiteNumber(current.is_day, "daylight") === 1,
  };
}

export async function getForecast(location: WeatherLocation, days: number) {
  const payload = await fetchJson(
    weatherUrl(location, {
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      days: 5,
    }),
  );
  const daily = record(payload.daily, "daily forecast");
  const dates = stringArray(daily.time, "forecast dates");
  const codes = numberArray(daily.weather_code, "forecast weather codes");
  const highs = numberArray(daily.temperature_2m_max, "forecast highs");
  const lows = numberArray(daily.temperature_2m_min, "forecast lows");
  const rain = numberArray(daily.precipitation_probability_max, "forecast precipitation");
  const length = Math.min(days, dates.length, codes.length, highs.length, lows.length);

  return {
    source: "Open-Meteo live server tool",
    location: location.name,
    days: Array.from({ length }, (_, index) => ({
      date: dates[index],
      condition: weatherCondition(codes[index]),
      highF: highs[index],
      lowF: lows[index],
      precipitationProbabilityPercent: rain[index] ?? 0,
    })),
  };
}

export async function getAirQuality(location: WeatherLocation) {
  const url = new URL(AIR_ENDPOINT);
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set("current", "us_aqi,pm2_5,pm10,ozone,uv_index");
  url.searchParams.set("timezone", "auto");
  const payload = await fetchJson(url);
  const current = record(payload.current, "current air quality");
  const aqi = finiteNumber(current.us_aqi, "US AQI");

  return {
    source: "Open-Meteo live server tool",
    location: location.name,
    observedAt: String(current.time ?? "now"),
    usAqi: aqi,
    category: airQualityCategory(aqi),
    pm25MicrogramsPerCubicMeter: finiteNumber(current.pm2_5, "PM2.5"),
    pm10MicrogramsPerCubicMeter: finiteNumber(current.pm10, "PM10"),
    ozoneMicrogramsPerCubicMeter: finiteNumber(current.ozone, "ozone"),
    uvIndex: finiteNumber(current.uv_index, "UV index"),
  };
}
