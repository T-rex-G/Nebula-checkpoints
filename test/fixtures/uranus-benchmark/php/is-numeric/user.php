<?php
$conn = mysqli_connect('localhost', 'app', getenv('DB_PASSWORD'), 'app');
$id = $_GET['id'];
if (!is_numeric($id)) {
    http_response_code(400);
    exit;
}
mysqli_query($conn, "SELECT * FROM users WHERE id = $id");
