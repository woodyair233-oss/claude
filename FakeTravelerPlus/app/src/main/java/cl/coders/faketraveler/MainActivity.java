package cl.coders.faketraveler;

import static cl.coders.faketraveler.MainActivity.SourceChange.CHANGE_FROM_EDITTEXT;
import static cl.coders.faketraveler.MainActivity.SourceChange.CHANGE_FROM_MAP;
import static cl.coders.faketraveler.MainActivity.SourceChange.LOAD;
import static cl.coders.faketraveler.MainActivity.SourceChange.NONE;
import static cl.coders.faketraveler.SharedPrefsUtil.getDouble;
import static cl.coders.faketraveler.SharedPrefsUtil.migrateOldPreferences;
import static cl.coders.faketraveler.SharedPrefsUtil.putDouble;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.SharedPreferences.Editor;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.PackageManager.NameNotFoundException;
import android.location.Location;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.Log;
import android.view.View;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Spinner;
import android.widget.TextView;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.StringRes;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.google.android.material.button.MaterialButton;
import com.google.android.material.button.MaterialButtonToggleGroup;
import com.google.android.material.snackbar.Snackbar;

import org.json.JSONArray;
import org.json.JSONException;

import java.text.DecimalFormat;
import java.text.DecimalFormatSymbols;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;


public class MainActivity extends AppCompatActivity {

    @NonNull
    public static final String sharedPrefKey = "cl.coders.faketraveler.sharedprefs";
    @NonNull
    public static final DecimalFormat DECIMAL_FORMAT = new DecimalFormat("0.######", DecimalFormatSymbols.getInstance(Locale.ROOT));

    private static final String MODE_POINT = "point";
    private static final String MODE_ROUTE = "route";

    private MaterialButton buttonApplyStop;
    private MaterialButton buttonPause;
    private MaterialButtonToggleGroup toggleMode;
    private View barPoint;
    private View barRoute;
    private TextView textRouteInfo;
    private EditText editRouteSpeed;
    private Spinner spinnerLoopMode;
    private WebView webView;
    private EditText editTextLat;
    private EditText editTextLng;
    private Context context;
    private int currentVersion;

    @NonNull
    private SourceChange srcChange = NONE;
    /** True while the page in the WebView is loaded and its functions can be called. */
    private boolean mapReady = false;

    @NonNull
    private MockState mockState = MockState.NOT_MOCKED;
    /** The first state delivered is the current one, not a change worth a snackbar. */
    private boolean stateSeen = false;

    @NonNull
    private final ActivityResultLauncher<String[]> permissionLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(), this::onPermissionResult);

    // Config
    private int version;
    private double lat;
    private double lng;
    private double zoom;
    private int mockCount;
    private int mockFrequency;
    private double dLat;
    private double dLng;
    private boolean mockSpeed;
    private String mapProvider;
    private String mode;
    @NonNull
    private List<LatLng> route = new ArrayList<>();
    private double routeSpeedKmh;
    @NonNull
    private RouteSimulator.LoopMode loopMode = RouteSimulator.LoopMode.ONCE;

    @Override
    @SuppressLint("SetJavaScriptEnabled") // XSS unlikely an issue here...
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.main_layout), (v, insets) -> {
            Insets bars = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout()
            );
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        context = getApplicationContext();
        webView = findViewById(R.id.webView0);
        WebAppInterface webAppInterface = new WebAppInterface(this);

        buttonApplyStop = findViewById(R.id.button_applyStop);
        buttonPause = findViewById(R.id.button_pause);
        toggleMode = findViewById(R.id.toggle_mode);
        barPoint = findViewById(R.id.bar_point);
        barRoute = findViewById(R.id.bar_route);
        textRouteInfo = findViewById(R.id.text_route_info);
        editRouteSpeed = findViewById(R.id.edit_route_speed);
        spinnerLoopMode = findViewById(R.id.spinner_loop_mode);
        editTextLat = findViewById(R.id.editTextLat);
        editTextLng = findViewById(R.id.editTextLng);

        buttonApplyStop.setOnClickListener(view -> {
            if (isMocking()) {
                sendToService(MockedLocationService.ACTION_STOP);
            } else {
                requestPermissionsAndApply();
            }
        });
        buttonPause.setOnClickListener(view -> sendToService(mockState == MockState.PAUSED
                ? MockedLocationService.ACTION_RESUME : MockedLocationService.ACTION_PAUSE));
        findViewById(R.id.button_settings).setOnClickListener(view ->
                startActivity(new Intent(getBaseContext(), MoreActivity.class)));
        findViewById(R.id.button_favorites).setOnClickListener(view -> showFavorites());
        findViewById(R.id.button_route_undo).setOnClickListener(view -> {
            if (route.isEmpty()) return;
            route.remove(route.size() - 1);
            onRouteChanged(false);
        });
        findViewById(R.id.button_route_clear).setOnClickListener(view -> {
            route.clear();
            onRouteChanged(false);
        });

        webView.getSettings().setJavaScriptEnabled(true);
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                mapReady = true;
                showModeOnMap(false);
                Location l = MockedLocationService.location().getValue();
                if (isMocking() && l != null) onMockedLocationChange(l);
            }
        });
        webView.getSettings().setJavaScriptCanOpenWindowsAutomatically(true);
        webView.addJavascriptInterface(webAppInterface, "Android");

        try {
            PackageInfo pInfo = this.getPackageManager().getPackageInfo(getPackageName(), 0);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                currentVersion = (int) (pInfo.getLongVersionCode() >> 32);
            } else {
                currentVersion = pInfo.versionCode;
            }
        } catch (NameNotFoundException e) {
            Log.e(MainActivity.class.toString(), "Could not read version info!", e);
        }

        loadSharedPrefs();
        applyIntentOrDefault(getIntent());

        editTextLat.addTextChangedListener(new SimpleTextWatcher(() -> {
            if (!editTextLat.getText().toString().isEmpty() && !editTextLat.getText().toString().equals("-")) {
                if (srcChange != CHANGE_FROM_MAP) {
                    try {
                        lat = Double.parseDouble(editTextLat.getText().toString());
                        setLatLng(lat, lng, CHANGE_FROM_EDITTEXT);
                    } catch (Throwable t) {
                        Log.e(MainActivity.class.toString(), "Could not read latitude!", t);
                    }
                }
            }
        }));

        editTextLng.addTextChangedListener(new SimpleTextWatcher(() -> {
            if (!editTextLng.getText().toString().isEmpty() && !editTextLng.getText().toString().equals("-")) {
                if (srcChange != CHANGE_FROM_MAP) {
                    try {
                        lng = Double.parseDouble(editTextLng.getText().toString());
                        setLatLng(lat, lng, CHANGE_FROM_EDITTEXT);
                    } catch (Throwable t) {
                        Log.e(MainActivity.class.toString(), "Could not read longitude!", t);
                    }
                }
            }
        }));

        editRouteSpeed.setText(DECIMAL_FORMAT.format(routeSpeedKmh));
        editRouteSpeed.addTextChangedListener(new SimpleTextWatcher(() -> {
            try {
                routeSpeedKmh = Double.parseDouble(editRouteSpeed.getText().toString());
            } catch (NumberFormatException e) {
                routeSpeedKmh = 0;
            }
            saveSettings();
            updateRouteInfo();
        }));

        spinnerLoopMode.setSelection(loopMode.ordinal());
        spinnerLoopMode.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                loopMode = RouteSimulator.LoopMode.values()[position];
                saveSettings();
                updateRouteInfo();
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {
            }
        });

        toggleMode.check(MODE_ROUTE.equals(mode) ? R.id.button_mode_route : R.id.button_mode_point);
        applyModeToViews();
        toggleMode.addOnButtonCheckedListener((group, checkedId, isChecked) -> {
            if (!isChecked) return;
            mode = checkedId == R.id.button_mode_route ? MODE_ROUTE : MODE_POINT;
            saveSettings();
            applyModeToViews();
            showModeOnMap(true);
        });

        MockedLocationService.state().observe(this, this::onMockedStateChange);
        MockedLocationService.location().observe(this, this::onMockedLocationChange);
    }

    @Override
    protected void onResume() {
        super.onResume();
        context = getApplicationContext();
        String previousProvider = mapProvider;
        loadSharedPrefs();
        // The base map was changed in the settings: reload the map page with it.
        if (previousProvider != null && !previousProvider.equals(mapProvider))
            applyIntentOrDefault(new Intent());
    }

    @Override
    protected void onNewIntent(@NonNull Intent intent) {
        super.onNewIntent(intent);

        // Opened from the notification: keep the current map.
        if (intent.getDataString() == null) return;
        loadSharedPrefs();
        applyIntentOrDefault(intent);
    }

    /**
     * Check and (re-)initialize shared preferences.
     */
    private void loadSharedPrefs() {
        migrateOldPreferences(context);

        SharedPreferences sharedPref = context.getSharedPreferences(sharedPrefKey, Context.MODE_PRIVATE);

        version = sharedPref.getInt("version", 0);
        lat = getDouble(sharedPref, "lat", 12);
        lng = getDouble(sharedPref, "lng", 15);
        zoom = getDouble(sharedPref, "zoom", 12);
        mockCount = sharedPref.getInt("mockCount", 0);
        mockFrequency = sharedPref.getInt("mockFrequency", 10);
        if (mockFrequency <= 0) mockFrequency = 1;
        dLat = getDouble(sharedPref, "dLat", 0);
        dLng = getDouble(sharedPref, "dLng", 0);
        mockSpeed = sharedPref.getBoolean("mockSpeed", true);
        mapProvider = sharedPref.getString("mapProvider", MapProviderUtil.getDefaultMapProvider());
        mode = sharedPref.getString("mode", MODE_POINT);
        routeSpeedKmh = getDouble(sharedPref, "routeSpeedKmh", 5);
        try {
            loopMode = RouteSimulator.LoopMode.valueOf(sharedPref.getString("loopMode", "ONCE"));
        } catch (IllegalArgumentException e) {
            loopMode = RouteSimulator.LoopMode.ONCE;
        }
        try {
            route = Favorite.decodePoints(new JSONArray(sharedPref.getString("route", "[]")));
        } catch (JSONException e) {
            route = new ArrayList<>();
        }

        if (version != currentVersion) {
            version = currentVersion;
            saveSettings();
        }
    }

    private void saveSettings() {
        Editor editor = context.getSharedPreferences(sharedPrefKey, Context.MODE_PRIVATE).edit();

        editor.putInt("version", version);
        putDouble(editor, "lat", lat);
        putDouble(editor, "lng", lng);
        putDouble(editor, "zoom", zoom);
        editor.putInt("mockCount", mockCount);
        editor.putInt("mockFrequency", mockFrequency);
        putDouble(editor, "dLat", dLat);
        putDouble(editor, "dLng", dLng);
        editor.putBoolean("mockSpeed", mockSpeed);
        editor.putString("mapProvider", mapProvider);
        editor.putString("mode", mode);
        putDouble(editor, "routeSpeedKmh", routeSpeedKmh);
        editor.putString("loopMode", loopMode.name());
        editor.putString("route", encodeRoute(route));

        editor.apply();
    }

    private void applyIntentOrDefault(Intent intent) {
        String intentData = intent.getDataString();
        if (intentData != null) {
            try {
                GeoUri uri = GeoUri.parse(intentData);
                Log.i(MainActivity.class.toString(), "Received geo intent: " + uri);
                if (uri != null) {
                    lat = uri.lat();
                    lng = uri.lng();
                    Double zoomTmp = uri.zoom();
                    if (zoomTmp != null) zoom = zoomTmp;
                    mode = MODE_POINT;
                    if (toggleMode != null) toggleMode.check(R.id.button_mode_point);
                }
            } catch (Throwable t) {
                Log.e(MainActivity.class.toString(), "Could not read geo intent!", t);
            }
        }

        setLatLng(lat, lng, LOAD);

        mapReady = false;
        webView.loadUrl(Uri.parse("file:///android_asset/map.html").buildUpon()
                .appendQueryParameter("lat", "" + lat)
                .appendQueryParameter("lng", "" + lng)
                .appendQueryParameter("zoom", "" + zoom)
                .appendQueryParameter("provider", mapProvider)
                .build()
                .toString());
    }

    // ---- Starting and controlling the mock ----

    private boolean isMocking() {
        return mockState == MockState.MOCKED || mockState == MockState.PAUSED || mockState == MockState.ARRIVED;
    }

    /**
     * Android 14+ only lets a foreground service of type "location" run with a location permission,
     * and Android 13+ needs the notification permission to show its controls.
     */
    private void requestPermissionsAndApply() {
        List<String> missing = new ArrayList<>();
        if (!hasLocationPermission()) {
            missing.add(Manifest.permission.ACCESS_FINE_LOCATION);
            missing.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (missing.isEmpty()) {
            applyLocation();
        } else {
            permissionLauncher.launch(missing.toArray(new String[0]));
        }
    }

    private void onPermissionResult(Map<String, Boolean> result) {
        if (hasLocationPermission()) {
            applyLocation();
        } else {
            showSnackbar(R.string.MainActivity_NeedLocationPermission);
        }
    }

    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Starts the mock service with the point or route currently shown.
     */
    protected void applyLocation() {
        Intent intent = new Intent(this, MockedLocationService.class);

        if (MODE_ROUTE.equals(mode)) {
            if (route.isEmpty()) {
                showSnackbar(R.string.MainActivity_NoRoute);
                return;
            }
            if (routeSpeedKmh <= 0) {
                showSnackbar(R.string.MainActivity_NoSpeed);
                return;
            }
            intent.setAction(MockedLocationService.ACTION_START_ROUTE)
                    .putExtra(MockedLocationService.EXTRA_ROUTE, encodeRoute(route))
                    .putExtra(MockedLocationService.EXTRA_SPEED, (float) (routeSpeedKmh / 3.6))
                    .putExtra(MockedLocationService.EXTRA_LOOP_MODE, loopMode.name());
        } else {
            if (latIsEmpty() || lngIsEmpty()) {
                showSnackbar(context.getResources().getString(R.string.MainActivity_NoLatLong));
                return;
            }

            lat = Double.parseDouble(editTextLat.getText().toString());
            lng = Double.parseDouble(editTextLng.getText().toString());

            float[] speed = {0};
            if (mockSpeed) {
                Location.distanceBetween(lat, lng, lat + dLat / 1000000, lng + dLng / 1000000, speed);
                speed[0] /= mockFrequency;
            }
            intent.setAction(MockedLocationService.ACTION_START_POINT)
                    .putExtra(MockedLocationService.EXTRA_LAT, lat)
                    .putExtra(MockedLocationService.EXTRA_LNG, lng)
                    .putExtra(MockedLocationService.EXTRA_D_LAT, dLat / 1000000)
                    .putExtra(MockedLocationService.EXTRA_D_LNG, dLng / 1000000)
                    .putExtra(MockedLocationService.EXTRA_INTERVAL_MS, mockFrequency * 1000L)
                    .putExtra(MockedLocationService.EXTRA_MAX_TIMES, mockCount)
                    .putExtra(MockedLocationService.EXTRA_SPEED, speed[0]);
        }

        saveSettings();
        ContextCompat.startForegroundService(this, intent);
    }

    private void sendToService(@NonNull String action) {
        startService(new Intent(this, MockedLocationService.class).setAction(action));
    }

    private void onMockedStateChange(MockState state) {
        MockState previous = mockState;
        mockState = state;
        if (stateSeen) switch (state) {
            case NOT_MOCKED -> {
                if (previous != MockState.NOT_MOCKED && previous != MockState.MOCK_ERROR)
                    showSnackbar(R.string.MainActivity_MockStopped);
            }
            case MOCKED -> {
                if (previous == MockState.NOT_MOCKED || previous == MockState.MOCK_ERROR)
                    showSnackbar(R.string.MainActivity_MockApplied);
            }
            case ARRIVED -> showSnackbar(R.string.Notification_Arrived);
            case MOCK_ERROR -> showSnackbar(R.string.MainActivity_MockNotApplied);
            case PAUSED -> {
            }
        }
        stateSeen = true;

        boolean running = isMocking();
        buttonApplyStop.setText(running ? R.string.ActivityMain_Stop : R.string.ActivityMain_Apply);
        buttonPause.setVisibility(running ? View.VISIBLE : View.GONE);
        buttonPause.setText(state == MockState.PAUSED ? R.string.Action_Resume : R.string.Action_Pause);
        // Switching modes mid-mock would leave the UI describing something that is not running.
        for (int i = 0; i < toggleMode.getChildCount(); i++)
            toggleMode.getChildAt(i).setEnabled(!running);
        if (!running) callJs("hideMockPosition()");
    }

    private void onMockedLocationChange(Location location) {
        if (!isMocking()) return;
        callJs("showMockPosition(" + location.getLatitude() + "," + location.getLongitude() + ")");
    }

    // ---- Point / route mode ----

    private void applyModeToViews() {
        boolean isRoute = MODE_ROUTE.equals(mode);
        barPoint.setVisibility(isRoute ? View.GONE : View.VISIBLE);
        barRoute.setVisibility(isRoute ? View.VISIBLE : View.GONE);
        updateRouteInfo();
    }

    /** Tells the map page which mode is active and what to draw. */
    private void showModeOnMap(boolean fit) {
        if (MODE_ROUTE.equals(mode)) {
            callJs("setMode('route')");
            callJs("setRoute(" + encodeRoute(route) + "," + fit + ")");
        } else {
            callJs("setMode('point')");
            setMapMarker(lat, lng);
        }
    }

    /** Called by the map when it is long pressed in route mode. */
    void addWaypoint(double wLat, double wLng) {
        route.add(new LatLng(wLat, wLng));
        onRouteChanged(false);
    }

    private void onRouteChanged(boolean fit) {
        saveSettings();
        updateRouteInfo();
        callJs("setRoute(" + encodeRoute(route) + "," + fit + ")");
        if (isMocking() && MODE_ROUTE.equals(mode))
            showSnackbar(R.string.MainActivity_RestartToApply);
    }

    private void updateRouteInfo() {
        double meters = route.isEmpty() ? 0
                : new RouteSimulator(route, 1, loopMode).totalMeters();
        String distance = meters >= 1000
                ? String.format(Locale.getDefault(), "%.2f km", meters / 1000)
                : String.format(Locale.getDefault(), "%.0f m", meters);
        String text = getString(R.string.ActivityMain_RouteInfo, route.size(), distance);
        if (routeSpeedKmh > 0 && meters > 0) {
            long seconds = Math.round(meters / (routeSpeedKmh / 3.6));
            text += " · " + String.format(Locale.ROOT, "%d:%02d", seconds / 60, seconds % 60);
        }
        textRouteInfo.setText(text);
    }

    @NonNull
    private static String encodeRoute(@NonNull List<LatLng> points) {
        try {
            return Favorite.encodePoints(points).toString();
        } catch (JSONException e) {
            return "[]";
        }
    }

    // ---- Favorites ----

    private void showFavorites() {
        List<Favorite> favorites = Favorite.loadAll(context);
        List<String> labels = new ArrayList<>();
        for (Favorite f : favorites)
            labels.add((f.isRoute() ? "🛣 " : "📍 ") + f.name());

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(R.string.ActivityMain_Favorites)
                .setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_list_item_1, labels),
                        (d, which) -> loadFavorite(favorites.get(which)))
                .setPositiveButton(MODE_ROUTE.equals(mode)
                        ? R.string.Favorites_SaveRoute : R.string.Favorites_SavePlace, (d, w) -> saveFavorite())
                .setNegativeButton(R.string.Common_Cancel, null)
                .setMessage(favorites.isEmpty() ? getString(R.string.Favorites_Empty) : null)
                .create();
        dialog.show();
        if (dialog.getListView() != null) {
            dialog.getListView().setOnItemLongClickListener((parent, view, position, id) -> {
                Favorite f = favorites.get(position);
                new AlertDialog.Builder(this)
                        .setMessage(getString(R.string.Favorites_DeleteConfirm, f.name()))
                        .setPositiveButton(R.string.Favorites_Delete, (d, w) -> {
                            favorites.remove(position);
                            Favorite.saveAll(context, favorites);
                            dialog.dismiss();
                        })
                        .setNegativeButton(R.string.Common_Cancel, null)
                        .show();
                return true;
            });
        }
    }

    private void saveFavorite() {
        List<LatLng> points;
        if (MODE_ROUTE.equals(mode)) {
            if (route.size() < 2) {
                showSnackbar(R.string.Favorites_RouteTooShort);
                return;
            }
            points = new ArrayList<>(route);
        } else {
            points = List.of(new LatLng(lat, lng));
        }

        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT);
        input.setSingleLine(true);
        input.setHint(R.string.Favorites_NameHint);
        int pad = Math.round(20 * getResources().getDisplayMetrics().density);
        FrameLayout container = new FrameLayout(this);
        container.setPadding(pad, pad / 2, pad, 0);
        container.addView(input);

        new AlertDialog.Builder(this)
                .setTitle(MODE_ROUTE.equals(mode) ? R.string.Favorites_SaveRoute : R.string.Favorites_SavePlace)
                .setView(container)
                .setPositiveButton(R.string.Common_Ok, (d, w) -> {
                    String name = input.getText().toString().trim();
                    if (name.isEmpty()) name = DECIMAL_FORMAT.format(points.get(0).lat()) + ", "
                            + DECIMAL_FORMAT.format(points.get(0).lng());
                    List<Favorite> favorites = Favorite.loadAll(context);
                    favorites.add(new Favorite(name, points));
                    Favorite.saveAll(context, favorites);
                    showSnackbar(R.string.Favorites_Saved);
                })
                .setNegativeButton(R.string.Common_Cancel, null)
                .show();
    }

    private void loadFavorite(@NonNull Favorite f) {
        if (isMocking()) {
            showSnackbar(R.string.MainActivity_StopFirst);
            return;
        }
        if (f.isRoute()) {
            route = new ArrayList<>(f.points());
            mode = MODE_ROUTE;
            toggleMode.check(R.id.button_mode_route);
            applyModeToViews();
            onRouteChanged(true);
        } else {
            mode = MODE_POINT;
            toggleMode.check(R.id.button_mode_point);
            applyModeToViews();
            LatLng p = f.points().get(0);
            setLatLng(p.lat(), p.lng(), LOAD);
        }
    }

    // ---- Helpers ----

    /**
     * Shows a snackbar
     */
    void showSnackbar(String str) {
        Snackbar.make(findViewById(R.id.main_layout), str, Snackbar.LENGTH_SHORT).show();
    }

    /**
     * Shows a snackbar
     */
    void showSnackbar(@StringRes int strRes) {
        Snackbar.make(findViewById(R.id.main_layout), strRes, Snackbar.LENGTH_SHORT).show();
    }

    /**
     * Returns true editTextLat has no text
     */
    boolean latIsEmpty() {
        return editTextLat.getText().toString().isBlank();
    }

    /**
     * Returns true editTextLng has no text
     */
    boolean lngIsEmpty() {
        return editTextLng.getText().toString().isBlank();
    }

    private void callJs(@NonNull String js) {
        if (!mapReady) return;
        webView.evaluateJavascript(js, null);
    }

    protected void setMapMarker(double lat, double lng) {
        callJs("setOnMap(" + lat + "," + lng + ")");
    }

    public void setZoom(double zoom) {
        this.zoom = zoom;
        saveSettings();
    }

    /**
     * Sets latitude and longitude
     *
     * @param mLat      latitude
     * @param mLng      longitude
     * @param srcChange CHANGE_FROM_EDITTEXT or CHANGE_FROM_MAP, indicates from where comes the change
     */
    void setLatLng(double mLat, double mLng, SourceChange srcChange) {
        lat = mLat;
        lng = mLng;

        if (srcChange == CHANGE_FROM_EDITTEXT || srcChange == LOAD) {
            setMapMarker(lat, lng);
        }
        if (srcChange == CHANGE_FROM_MAP || srcChange == LOAD) {
            this.srcChange = CHANGE_FROM_MAP;
            editTextLat.setText(DECIMAL_FORMAT.format(lat));
            editTextLng.setText(DECIMAL_FORMAT.format(lng));
            this.srcChange = NONE;
        }

        saveSettings();

        // Long pressing the map while a point mock runs moves the mocked location right away.
        if (srcChange == CHANGE_FROM_MAP && MODE_POINT.equals(mode) && isMocking()) {
            startService(new Intent(this, MockedLocationService.class)
                    .setAction(MockedLocationService.ACTION_MOVE_POINT)
                    .putExtra(MockedLocationService.EXTRA_LAT, lat)
                    .putExtra(MockedLocationService.EXTRA_LNG, lng));
        }
    }

    public enum SourceChange {
        NONE, LOAD, CHANGE_FROM_EDITTEXT, CHANGE_FROM_MAP
    }

    /** TextWatcher that only cares about the text after it changed. */
    private record SimpleTextWatcher(@NonNull Runnable afterChange) implements TextWatcher {
        @Override
        public void beforeTextChanged(CharSequence s, int start, int count, int after) {
        }

        @Override
        public void onTextChanged(CharSequence s, int start, int before, int count) {
        }

        @Override
        public void afterTextChanged(Editable s) {
            afterChange.run();
        }
    }

}
