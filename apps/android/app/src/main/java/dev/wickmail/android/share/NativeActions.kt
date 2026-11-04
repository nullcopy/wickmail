package dev.wickmail.android.share

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.widget.Toast
import dev.wickmail.android.R

/** Native clipboard and share helpers used by the bridge. */
object NativeActions {
    /** Copy text to the system clipboard and confirm it. */
    fun copy(context: Context, text: String) {
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        clipboard?.setPrimaryClip(ClipData.newPlainText(context.getString(R.string.app_name), text))
        Toast.makeText(context, R.string.copied, Toast.LENGTH_SHORT).show()
    }

    /** Open the system share sheet for text. */
    fun share(context: Context, text: String) {
        val send =
            Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
            }
        context.startActivity(Intent.createChooser(send, context.getString(R.string.share_title)))
    }
}
