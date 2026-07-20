UPDATE settings
SET value = CASE
    WHEN jsonb_typeof(value) = 'object' THEN jsonb_set(
        value,
        '{alerts}',
        '{"hostOffline":true,"sshCredentialInvalid":true,"containerExited":true,"containerUnhealthy":true,"restartFailed":true,"diskWarning":true,"diskCritical":true,"upgradeFailed":true}'::jsonb
            || CASE WHEN jsonb_typeof(value->'alerts') = 'object' THEN value->'alerts' ELSE '{}'::jsonb END,
        true
    )
    ELSE '{"intervalSeconds":30,"retentionDays":7,"diskWarningPercent":80,"diskCriticalPercent":90,"alerts":{"hostOffline":true,"sshCredentialInvalid":true,"containerExited":true,"containerUnhealthy":true,"restartFailed":true,"diskWarning":true,"diskCritical":true,"upgradeFailed":true}}'::jsonb
END, updated_at = now()
WHERE key = 'monitoring';
