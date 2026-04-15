declare global {
  interface Window {
    __cockpitGoogleMapsInit?: () => void;
  }
}

const SCRIPT_ID = "cockpit-google-maps-script";
let loaderPromise: Promise<typeof google.maps> | null = null;

export class GoogleMapsLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleMapsLoadError";
  }
}

function asMapsApi(): typeof google.maps {
  if (typeof window === "undefined" || !window.google || !window.google.maps) {
    throw new GoogleMapsLoadError("Google Maps API unavailable after load");
  }
  return window.google.maps;
}

export function loadGoogleMapsApi(apiKey: string): Promise<typeof google.maps> {
  const key = apiKey.trim();
  if (!key) {
    return Promise.reject(new GoogleMapsLoadError("Missing Google Maps API key (VITE_GOOGLE_MAPS_API_KEY)"));
  }

  if (typeof window !== "undefined" && window.google?.maps) {
    return Promise.resolve(window.google.maps);
  }

  if (loaderPromise) return loaderPromise;

  loaderPromise = new Promise<typeof google.maps>((resolve, reject) => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      reject(new GoogleMapsLoadError("Google Maps can only load in browser runtime"));
      return;
    }

    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing && window.google?.maps) {
      resolve(window.google.maps);
      return;
    }

    const callbackName = "__cockpitGoogleMapsInit";
    window[callbackName] = () => {
      try {
        resolve(asMapsApi());
      } catch (error) {
        reject(error instanceof Error ? error : new GoogleMapsLoadError(String(error)));
      } finally {
        if (window[callbackName]) {
          delete window[callbackName];
        }
      }
    };

    const script = existing ?? document.createElement("script");
    script.id = SCRIPT_ID;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      reject(new GoogleMapsLoadError("Google Maps script failed to load"));
    };
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      key
    )}&v=weekly&libraries=geometry&callback=${callbackName}`;

    if (!existing) {
      document.head.appendChild(script);
    }
  }).catch((error) => {
    loaderPromise = null;
    throw error;
  });

  return loaderPromise;
}
