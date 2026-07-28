const bcrypt = require('bcryptjs');
const db = require('../db/init');

async function main() {
    const [, , username, password] = process.argv;
    if (!username || !password) {
        console.error('Usage: node scripts/create_admin.js <username> <password>');
        process.exit(2);
    }

    const hash = bcrypt.hashSync(password, 10);
    try {
        const info = db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, hash);
        console.log(`Created admin '${username}' with id ${info.lastInsertRowid}`);
    } catch (e) {
        console.error('Failed to create admin:', e.message);
        process.exit(1);
    }
}

main();
