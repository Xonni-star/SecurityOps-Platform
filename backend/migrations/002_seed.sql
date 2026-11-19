INSERT INTO tenants (id,name) VALUES ('00000000-0000-0000-0000-000000000001','Acme Security') ON CONFLICT DO NOTHING;
INSERT INTO users (tenant_id,email,password_hash,role) VALUES ('00000000-0000-0000-0000-000000000001','admin@example.com', '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', 'admin') ON CONFLICT DO NOTHING;
