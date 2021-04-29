module.exports = {
  plugins: [
    // eslint-disable-next-line no-undef
    new webpack.DefinePlugin({
      IS_BROWSER: true,
    }),
  ],
};
