package com.wickmail.android

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest

/**
 * Reports whether the device currently has validated internet access.
 *
 * The shell uses this only to decide when to offer a retry; it never queues
 * work while offline.
 */
internal class ConnectivityMonitor(
    context: Context,
    private val onChange: (Boolean) -> Unit,
) {
    private val manager = context.getSystemService(ConnectivityManager::class.java)
    private var registered = false

    private val callback =
        object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = report()

            override fun onLost(network: Network) = report()

            override fun onCapabilitiesChanged(
                network: Network,
                networkCapabilities: NetworkCapabilities,
            ) = report()
        }

    fun start() {
        if (registered) return
        val request =
            NetworkRequest
                .Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
        manager?.registerNetworkCallback(request, callback)
        registered = true
    }

    fun stop() {
        if (!registered) return
        manager?.unregisterNetworkCallback(callback)
        registered = false
    }

    /** True when a validated internet-capable network is active. */
    fun isOnline(): Boolean {
        val network = manager?.activeNetwork ?: return false
        val capabilities = manager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    private fun report() = onChange(isOnline())
}
