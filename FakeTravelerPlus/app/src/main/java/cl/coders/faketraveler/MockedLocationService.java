package cl.coders.faketraveler;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.LiveData;
import androidx.lifecycle.MutableLiveData;

import org.json.JSONArray;
import org.json.JSONException;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Foreground service that keeps pushing mocked locations while the app is in the background.
 * <p>
 * Controlled with intents (see the ACTION_* constants) from the UI and from the notification.
 * The UI observes {@link #state()} and {@link #location()}.
 */
public class MockedLocationService extends Service {

    @NonNull
    private static final String TAG = MockedLocationService.class.getSimpleName();

    public static final String ACTION_START_POINT = "cl.coders.faketraveler.START_POINT";
    public static final String ACTION_START_ROUTE = "cl.coders.faketraveler.START_ROUTE";
    /** Moves a running point mock to a new location. */
    public static final String ACTION_MOVE_POINT = "cl.coders.faketraveler.MOVE_POINT";
    public static final String ACTION_PAUSE = "cl.coders.faketraveler.PAUSE";
    public static final String ACTION_RESUME = "cl.coders.faketraveler.RESUME";
    public static final String ACTION_STOP = "cl.coders.faketraveler.STOP";

    public static final String EXTRA_LAT = "lat";
    public static final String EXTRA_LNG = "lng";
    /** Degrees added to the latitude after every point mock. */
    public static final String EXTRA_D_LAT = "dLat";
    /** Degrees added to the longitude after every point mock. */
    public static final String EXTRA_D_LNG = "dLng";
    public static final String EXTRA_INTERVAL_MS = "intervalMs";
    /** Number of point mocks before stopping, 0 = infinite. */
    public static final String EXTRA_MAX_TIMES = "maxTimes";
    /** Meters per second. */
    public static final String EXTRA_SPEED = "speed";
    /** Waypoints as a JSON array of [lat, lng]. */
    public static final String EXTRA_ROUTE = "route";
    /** Name of a {@link RouteSimulator.LoopMode}. */
    public static final String EXTRA_LOOP_MODE = "loopMode";

    private static final String CHANNEL_ID = "mock_location";
    private static final int NOTIFICATION_ID = 1;
    private static final long ROUTE_INTERVAL_MS = 1000;
    private static final long NOTIFICATION_MIN_INTERVAL_MS = 5000;

    @NonNull
    private static final MutableLiveData<MockState> mockState = new MutableLiveData<>(MockState.NOT_MOCKED);
    @NonNull
    private static final MutableLiveData<Location> mockedLocation = new MutableLiveData<>();

    @NonNull
    public static LiveData<MockState> state() {
        return mockState;
    }

    @NonNull
    public static LiveData<Location> location() {
        return mockedLocation;
    }

    @NonNull
    private final Handler handler = new Handler(Looper.getMainLooper());
    @NonNull
    private final List<MockedLocationProvider> providers = new ArrayList<>();
    @Nullable
    private PowerManager.WakeLock wakeLock;
    @Nullable
    private Runnable tickTask;

    private boolean foreground = false;
    private boolean paused = false;
    private boolean arrived = false;
    private long lastNotificationAt = 0;

    // Point mode
    private double pointLat;
    private double pointLng;

    // Last pushed location, re-pushed unchanged while paused
    private double lastLat;
    private double lastLng;
    private float lastBearing;

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (action == null) {
            stopMock();
            return START_NOT_STICKY;
        }

        switch (action) {
            case ACTION_START_POINT, ACTION_START_ROUTE -> start(intent);
            case ACTION_MOVE_POINT -> {
                if (tickTask == null) break;
                pointLat = intent.getDoubleExtra(EXTRA_LAT, pointLat);
                pointLng = intent.getDoubleExtra(EXTRA_LNG, pointLng);
                lastLat = pointLat;
                lastLng = pointLng;
                // Show the jump right away instead of waiting for the next tick
                push(lastLat, lastLng, 0f, lastBearing);
            }
            case ACTION_PAUSE -> setPaused(true);
            case ACTION_RESUME -> setPaused(false);
            case ACTION_STOP -> stopMock();
        }
        // A control action for a mock that is not running (e.g. a stale notification)
        if (tickTask == null && !foreground) stopSelf(startId);
        return START_NOT_STICKY;
    }

    private void start(@NonNull Intent intent) {
        cancelTicks();
        paused = false;
        arrived = false;

        // Must be called promptly after startForegroundService(), before anything that can fail.
        if (!enterForeground()) return;

        try {
            for (MockedLocationProvider prov : providers) prov.shutdown();
            providers.clear();
            providers.add(new MockedLocationProvider(LocationManager.GPS_PROVIDER, this));
            providers.add(new MockedLocationProvider(LocationManager.NETWORK_PROVIDER, this));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                providers.add(new MockedLocationProvider(LocationManager.FUSED_PROVIDER, this));
            }
        } catch (SecurityException e) {
            Log.e(TAG, "Could not construct mock location providers!", e);
            mockState.setValue(MockState.MOCK_ERROR);
            stopMock();
            return;
        }

        if (ACTION_START_ROUTE.equals(intent.getAction())) {
            if (!startRoute(intent)) return;
        } else {
            startPoint(intent);
        }

        acquireWakeLock();
        mockState.setValue(MockState.MOCKED);
        handler.post(tickTask);
    }

    private void startPoint(@NonNull Intent intent) {
        pointLat = intent.getDoubleExtra(EXTRA_LAT, 0);
        pointLng = intent.getDoubleExtra(EXTRA_LNG, 0);
        double dLat = intent.getDoubleExtra(EXTRA_D_LAT, 0);
        double dLng = intent.getDoubleExtra(EXTRA_D_LNG, 0);
        long intervalMs = Math.max(100, intent.getLongExtra(EXTRA_INTERVAL_MS, 10_000));
        int maxTimes = intent.getIntExtra(EXTRA_MAX_TIMES, 0);
        float speed = intent.getFloatExtra(EXTRA_SPEED, 0);
        float bearing = dLat != 0 || dLng != 0
                ? RouteSimulator.bearingDegrees(new LatLng(0, 0), new LatLng(dLat, dLng))
                : 0f;

        tickTask = new Runnable() {
            private int count = 0;

            @Override
            public void run() {
                if (paused) {
                    push(lastLat, lastLng, 0f, lastBearing);
                } else {
                    push(pointLat, pointLng, speed, bearing);
                    pointLat += dLat;
                    pointLng += dLng;
                    if (maxTimes != 0 && ++count >= maxTimes) {
                        stopMock();
                        return;
                    }
                }
                handler.postDelayed(this, intervalMs);
            }
        };
    }

    private boolean startRoute(@NonNull Intent intent) {
        List<LatLng> waypoints;
        try {
            waypoints = Favorite.decodePoints(new JSONArray(intent.getStringExtra(EXTRA_ROUTE)));
        } catch (JSONException | NullPointerException e) {
            Log.e(TAG, "Invalid route!", e);
            waypoints = List.of();
        }
        if (waypoints.isEmpty()) {
            mockState.setValue(MockState.MOCK_ERROR);
            stopMock();
            return false;
        }
        RouteSimulator.LoopMode loopMode;
        try {
            loopMode = RouteSimulator.LoopMode.valueOf(intent.getStringExtra(EXTRA_LOOP_MODE));
        } catch (IllegalArgumentException | NullPointerException e) {
            loopMode = RouteSimulator.LoopMode.ONCE;
        }
        RouteSimulator sim = new RouteSimulator(waypoints, intent.getFloatExtra(EXTRA_SPEED, 1.4f), loopMode);

        tickTask = new Runnable() {
            /** Moving time so far, not counting pauses. */
            private long movingMs = 0;
            private long lastTickAt = SystemClock.elapsedRealtime();

            @Override
            public void run() {
                long now = SystemClock.elapsedRealtime();
                if (!paused) movingMs += now - lastTickAt;
                lastTickAt = now;

                RouteSimulator.State s = sim.stateAt(movingMs / 1000.0);
                push(s.lat(), s.lng(), paused ? 0f : s.speed(), s.bearing());
                if (s.finished() && !arrived) {
                    arrived = true;
                    mockState.setValue(MockState.ARRIVED);
                    updateNotification(true);
                }
                handler.postDelayed(this, ROUTE_INTERVAL_MS);
            }
        };
        return true;
    }

    private void push(double lat, double lng, float speed, float bearing) {
        lastLat = lat;
        lastLng = lng;
        lastBearing = bearing;
        for (MockedLocationProvider prov : providers)
            prov.pushLocation(lat, lng, speed, bearing);

        Location value = new Location(LocationManager.GPS_PROVIDER);
        value.setLatitude(lat);
        value.setLongitude(lng);
        value.setSpeed(speed);
        value.setBearing(bearing);
        value.setTime(System.currentTimeMillis());
        mockedLocation.setValue(value);
        updateNotification(false);
    }

    private void setPaused(boolean pause) {
        if (tickTask == null || paused == pause) return;
        paused = pause;
        mockState.setValue(pause ? MockState.PAUSED : arrived ? MockState.ARRIVED : MockState.MOCKED);
        updateNotification(true);
    }

    private void stopMock() {
        cancelTicks();
        for (MockedLocationProvider prov : providers) prov.shutdown();
        providers.clear();
        releaseWakeLock();
        if (foreground) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            foreground = false;
        }
        if (mockState.getValue() != MockState.MOCK_ERROR) mockState.setValue(MockState.NOT_MOCKED);
        stopSelf();
    }

    private void cancelTicks() {
        if (tickTask != null) handler.removeCallbacks(tickTask);
        tickTask = null;
    }

    @Override
    public void onDestroy() {
        cancelTicks();
        for (MockedLocationProvider prov : providers) prov.shutdown();
        providers.clear();
        releaseWakeLock();
        if (mockState.getValue() != MockState.MOCK_ERROR) mockState.setValue(MockState.NOT_MOCKED);
        super.onDestroy();
    }

    // ---- Foreground notification ----

    private boolean enterForeground() {
        createChannel();
        try {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0;
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type);
            foreground = true;
            return true;
        } catch (RuntimeException e) {
            // e.g. SecurityException on Android 14+ when the location permission was revoked
            Log.e(TAG, "Could not start foreground service!", e);
            mockState.setValue(MockState.MOCK_ERROR);
            stopMock();
            return false;
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID,
                getString(R.string.Notification_Channel), NotificationManager.IMPORTANCE_LOW);
        channel.setShowBadge(false);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private void updateNotification(boolean force) {
        if (!foreground) return;
        long now = SystemClock.elapsedRealtime();
        if (!force && now - lastNotificationAt < NOTIFICATION_MIN_INTERVAL_MS) return;
        lastNotificationAt = now;
        NotificationManager nm = ContextCompat.getSystemService(this, NotificationManager.class);
        if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification());
    }

    @NonNull
    private Notification buildNotification() {
        int title = paused ? R.string.Notification_Paused
                : arrived ? R.string.Notification_Arrived
                : R.string.Notification_Running;
        String text = String.format(Locale.ROOT, "%.6f, %.6f", lastLat, lastLng);

        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_mock)
                .setContentTitle(getString(title))
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .addAction(0, getString(paused ? R.string.Action_Resume : R.string.Action_Pause),
                        serviceIntent(this, paused ? ACTION_RESUME : ACTION_PAUSE, 1))
                .addAction(0, getString(R.string.ActivityMain_Stop), serviceIntent(this, ACTION_STOP, 2))
                .build();
    }

    @NonNull
    private static PendingIntent serviceIntent(@NonNull Context ctx, @NonNull String action, int requestCode) {
        Intent i = new Intent(ctx, MockedLocationService.class).setAction(action);
        return PendingIntent.getService(ctx, requestCode, i,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    // ---- Wake lock: keep ticking with the screen off ----

    private void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FakeTraveler:mock");
            wakeLock.setReferenceCounted(false);
        }
        wakeLock.acquire();
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    }

}
