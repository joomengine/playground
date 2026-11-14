# Using the database viewer

Launch a Joomla site, then select **DB** beside **JoomEngine Code**. Adminer opens against that running site's embedded MariaDB database. Its application code loads on first use. There is no second Joomla installation or external database connection.

The cylinder icon comes from the project's Remix Icon v2.5.0 set and inherits the current light or dark interface colour. The header label remains **DB**; narrow screens show only the icon, with the full database action available to assistive technology and in its tooltip.

## Work beside the site

Select **DB** or **JoomEngine Code** to switch tools. Only one tool can occupy the embedded workspace beside the site. Switching tools hides the previous panel without discarding editor buffers or the database page's unfinished form values. The site preview remains mounted and running.

Use the panel's layout selector for left, right, bottom, floating, or full workspace. Each tool remembers its own layout. Maximizing hides the site preview visually; restoring returns to the previous arrangement. On narrow viewports, side docks display beneath the site so controls remain usable.

Database changes operate on the active site's actual data. Use **Refresh site** in Code, or the toolbar **Reload** action while Code is open, when you want Joomla to display the effect of a change. This refresh does not restart PHP, submit unfinished Adminer forms or run SQL.

## Detached database window

**Detach database viewer** opens a separate browser window and releases the embedded workspace. Code can then remain visible next to the site while the database is visible in its own window. Keep the original Playground tab open: it owns PHP, MariaDB, and persistence.

The detached window opens the current database location and transfers editable form drafts. This transfer never replays a submitted POST request or executes a query. A page reached by a POST is reopened with GET; previously submitted query results may therefore need an explicit new query to display in the detached view. Unsubmitted query text is retained. File selections cannot be transferred by browsers: finish or clear a selected import file before detaching. Draft transfer is bounded to 1 MiB.

Choose **Return to owner tab**, or close the detached window, to return its current location and draft to the main panel. The main panel reloads that location with GET so table data reflects detached changes; submitted SQL results are not replayed. Returning the database panel hides an embedded Code panel. Detached Code windows remain independent.

## Saving and exporting

Completed database changes persist automatically with the live site. Playground's **Save** stores deployment configuration only. **Backup** opens the Backups panel, where you can deliberately create a complete site archive while the site keeps running, update an existing backup, or restore, download and delete backups. **Download** retains its complete-site, files-only and SQL choices; filenames include UTC date and time. An uploaded complete site becomes the persisted live site, without automatically adding a backup.

Browser backups require the archive's actual size plus a 10 MiB margin. If storage cannot accept it, the panel states that no new backup was saved and offers the archive for download. The panel also manages other removable Playground data; unassigned stores require individual confirmation, and the live site is protected. Database viewer application files remain outside the Joomla document root and portable site exports.

Showing, hiding, docking, or detaching the viewer never submits a database form implicitly. Complete intended changes inside Adminer. **Stop** preserves the live data and changes Restart to **Start**; **Restart** restarts the same PHP runtime without redeployment. **Reset** confirms before replacing the live site with the default JCB deployment. Save or discard unfinished database forms when prompted before a runtime transition.

Ctrl-click, Command-click or middle-click **Site** or **Admin** to open another full Playground view, including DB and Code controls, against the same live runtime. Keep its original owner window open; a plain Joomla link opens only the site.
