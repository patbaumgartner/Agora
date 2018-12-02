/*eslint no-process-exit: 0 */
/* eslint no-console: 0 */
'use strict';

const async = require('async');

require('./configure'); // initializing parameters
const beans = require('simple-configure').get('beans');
const activitystore = beans.get('activitystore');

let really = process.argv[2];
if (!really || really !== 'really') {
  console.log('If you want to run this script, append "really" to the command line.');
  process.exit();
}

activitystore.allActivities((err, activities) => {
  if (err) {
    console.log(err);
    process.exit();
  }
  async.eachSeries(
    activities, (activity, callback) => {
      activitystore.saveActivity(activity, (err2, res) => {
        console.log(res);
        callback(err2, res);
      });
    }, (err1) => {
      if (err1) {
        console.log(err1);
        process.exit();
      }
      process.exit();
    }
  );


});
