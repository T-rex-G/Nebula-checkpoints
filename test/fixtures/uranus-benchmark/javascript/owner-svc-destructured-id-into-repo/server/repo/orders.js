exports.removeOrder = async orderId => {
  const order = await Order.findById(orderId);
  await order.deleteOne();
};
