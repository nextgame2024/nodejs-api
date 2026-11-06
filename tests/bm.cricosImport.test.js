import { describe, expect, test } from '@jest/globals';
import { planCricosImport } from '../scripts/import-cricos-catalog.mjs';

const institutions = `CRICOS Provider Code,Trading Name,Institution Name,Institution Type,Institution Capacity,Website,Postal Address Line 1,Postal Address Line 2,Postal Address Line 3,Postal Address Line 4,Postal Address City,Postal Address State,Postal Address Postcode
04100H,Cubby College,A GRADE EDUCATION AND TRAINING PTY LIMITED,Private,"1,250",https://example.test,PO Box 1,,,,Sydney,NSW,2000
`;
const locations = `CRICOS Provider Code,Institution Name,Location Name,Location Type,Address Line 1,Address Line 2,Address Line 3,Address Line 4,City,State,Postcode
04100H,A GRADE EDUCATION AND TRAINING PTY LIMITED,Kent Street,Location owned and operated by provider,Level 5 545 Kent Street,,,,Sydney,NSW,2000
`;
const courses = `CRICOS Provider Code,Institution Name,CRICOS Course Code,Course Name,VET National Code,Dual Qualification,Field of Education 1 Broad Field,Field of Education 1 Narrow Field,Field of Education 1 Detailed Field,Field of Education 2 Broad Field,Field of Education 2 Narrow Field,Field of Education 2 Detailed Field,Course Level,Foundation Studies,Work Component,Work Component Hours/Week,Work Component Weeks,Work Component Total Hours,Course Language,Duration (Weeks),Tuition Fee,Non Tuition Fee,Estimated Total Course Cost,Expired
04100H,A GRADE EDUCATION AND TRAINING PTY LIMITED,112441K,Certificate III,CHC30121,No,07 - Education,0701 - Teacher Education,070101 - Early Childhood,,,,Certificate III,No,Yes,20.00,12,240,English,78,"$12,000.00",$550.00,"$12,550.00",No
`;
const courseLocations = `CRICOS Provider Code,Institution Name,CRICOS Course Code,Location Name,Location City,Location State
04100H,A GRADE EDUCATION AND TRAINING PTY LIMITED,112441K,Kent Street,Sydney,NSW
`;

describe('CRICOS catalogue import planning', () => {
  test('normalizes the four official exports without dropping relationships', () => {
    const plan = planCricosImport({ institutions, locations, courses, courseLocations });
    expect(plan.counts).toEqual({ providers: 1, locations: 1, courses: 1, activeCourses: 1, courseLocations: 1 });
    expect(plan.providers[0]).toEqual(expect.objectContaining({ providerCode: '04100H', institutionCapacity: 1250 }));
    expect(plan.courses[0]).toEqual(expect.objectContaining({ tuitionFeeCents: 1200000, expired: false }));
    expect(plan.courseLocations[0].locationSourceKey).toBe(plan.locations[0].sourceKey);
  });

  test('rejects a course-location row that cannot be mapped to an official site', () => {
    expect(() => planCricosImport({ institutions, locations, courses,
      courseLocations: courseLocations.replace('Kent Street', 'Unknown Campus') })).toThrow('unknown location');
  });
});
