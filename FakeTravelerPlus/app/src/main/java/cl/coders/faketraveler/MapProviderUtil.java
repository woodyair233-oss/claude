package cl.coders.faketraveler;

import androidx.annotation.NonNull;

public final class MapProviderUtil {

    /**
     * Base maps offered in the settings, in the order of the MapPresets string array.
     * The Gaode (AMap) presets are implemented in assets/chinamaps.js, the rest by leaflet-providers.
     */
    @NonNull
    public static final String[] PRESETS = {"GaoDe.Normal", "GaoDe.Satellite", "OpenStreetMap"};

    private MapProviderUtil() {
        throw new UnsupportedOperationException();
    }

    /**
     * Gaode loads quickly in mainland China and still shows the rest of the world; the app UI is Chinese only.
     */
    @NonNull
    public static String getDefaultMapProvider() {
        return PRESETS[0];
    }

}
