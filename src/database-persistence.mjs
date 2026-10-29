/**
 * Bridge 0.1.7 syncs its filesystem without checkpointing InnoDB's dirty pages.
 * Keep this compatibility guard until the pinned bridge does both itself.
 * Call only while the caller has paused PHP/database traffic (issue #5).
 */
export async function checkpointAndPersist(database, { persistent = true } = {}) {
  if (!persistent) { await database.flush(); return; }
  const call = async payload => {
    const response = JSON.parse(await database.hostCalls['mariadb.v1'](JSON.stringify({ version: 1, ...payload })));
    if (response?.version !== 1 || response.ok !== true) {
      const error = new Error(`MariaDB save failed: ${response?.error?.message || 'Invalid checkpoint response.'}`);
      error.code = response?.error?.code || 'DATABASE_CHECKPOINT_FAILED';
      throw error;
    }
    return response.result;
  };
  const { connection } = await call({ op: 'connect' });
  if (typeof connection !== 'string' || !connection) throw new Error('MariaDB did not open a checkpoint connection.');
  let checkpointError;
  try {
    await call({ op: 'query', connection, sql: 'SET GLOBAL innodb_log_checkpoint_now=ON' });
  } catch (error) {
    checkpointError = error;
    throw error;
  } finally {
    try { await call({ op: 'close', connection }); }
    catch (error) {
      if (!checkpointError) throw error;
      checkpointError.message += ` Connection cleanup also failed: ${error.message}`;
    }
  }
  // Never acknowledge a save or persist a fresh, incomplete InnoDB tablespace
  // when the checkpoint or connection cleanup failed.
  await database.flush();
}
