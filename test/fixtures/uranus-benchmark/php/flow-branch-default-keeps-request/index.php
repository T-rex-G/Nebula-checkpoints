<?php
$conn = mysqli_connect('localhost', 'app', getenv('DB_PASSWORD'), 'app');
$name = $_GET['name'];
if ($name === '') {
    $name = 'all';
}
$result = mysqli_query($conn, "SELECT * FROM items WHERE name = '" . $name . "'"); // expect: SEC-001 confirmed
