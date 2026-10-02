/** The exact error Telegram returned in production on 2026-10-02 for a group upgraded to a supergroup. */
function upgradedError(newId = -1001234567890) {
  const err = new Error('400: Bad Request: group chat was upgraded to a supergroup chat');
  err.response = {
    error_code: 400,
    description: 'Bad Request: group chat was upgraded to a supergroup chat',
    parameters: { migrate_to_chat_id: newId },
  };
  return err;
}

module.exports = { upgradedError };
