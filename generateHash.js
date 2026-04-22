const bcrypt = require('bcryptjs');
bcrypt.hash('Admin@1234', 10).then(hash => {
  console.log('\nRun this in Railway query box:\n');
  console.log(`UPDATE users SET password_hash = '${hash}' WHERE email = 'admin@school.ac.ke';`);
  console.log('\nThen login with Admin@1234\n');
});