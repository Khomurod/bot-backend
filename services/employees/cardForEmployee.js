'use strict';

/**
 * An employee's birthday card as it is posted: drawn with their stored photo
 * when it still decodes, with their initials when it does not. Used by the
 * birthday post (services/employeeBirthdayWishService.js) and by the race
 * boards' restore after a restart (services/grossRace/birthdayRestore.js), so
 * both show the same card.
 */
const employeesDb = require('../../database/companyEmployees');
const { renderBirthdayCard } = require('./birthdayCard');

async function prepareCard(employee) {
  const photo = await employeesDb.getPhoto(employee.id);
  try {
    return await renderBirthdayCard(employee, photo);
  } catch (err) {
    // A stored photo that no longer decodes must not cost anyone their
    // birthday: the card goes out with the initials instead.
    if (!photo) throw err;
    console.warn(`[EMP-BIRTHDAY] Photo for employee ${employee.id} unreadable, posting without it:`, err.message);
    return renderBirthdayCard(employee, null);
  }
}

module.exports = { prepareCard };
