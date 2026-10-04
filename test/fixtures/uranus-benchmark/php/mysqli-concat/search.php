<?php
$conn = mysqli_connect('localhost', 'app', getenv('DB_PASSWORD'), 'app');
$term = $_GET['q'];
$result = mysqli_query($conn, "SELECT * FROM products WHERE name LIKE '%" . $term . "%'"); // expect: SEC-001
