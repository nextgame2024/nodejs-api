import mysql from "mysql2/promise";

const pool = mysql.createPool({
  host: "linqueate.com",
  user: "linqueat_nodejsapi",
  password: "Goldenboot2022",
  database: "linqueat_nodejsapi",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

export default pool;
