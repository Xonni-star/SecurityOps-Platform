INSERT INTO permissions(key,description) VALUES
 ('providers:read','View configured provider verification status')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions(role,permission_id)
SELECT 'admin',id FROM permissions WHERE key='providers:read'
ON CONFLICT DO NOTHING;
