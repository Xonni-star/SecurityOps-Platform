INSERT INTO tenants (id,name) VALUES ('00000000-0000-0000-0000-000000000001','Acme Security') ON CONFLICT DO NOTHING;
INSERT INTO users (tenant_id,email,password_hash,role) VALUES ('00000000-0000-0000-0000-000000000001','admin@example.com', '$argon2id$v=19$m=65536,t=3,p=4$0KnRS4Yz9XkKMBGioeBC+A$LXN23uqAVXwQRLmuUmNxE/H1z20mTSpSj0ps8gLzTsk', 'admin') ON CONFLICT DO NOTHING;
